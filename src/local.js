/**
 * 本机 breeze-tts-2.cpp 服务：文字 → WAV，不需要密钥。
 *
 * 接口（见该服务的 docs/server.md）：POST <base>/v1/audio/speech 收 OpenAI 语音接口的 JSON
 * 请求体，response_format 选 wav 时直接回 audio/wav。同一路径也收 multipart 表单，那一路回的是
 * 裸 PCM，所以这里两路都认：先找 RIFF 头，没有就按 X-Sample-Rate 补一个 WAV 头。
 *
 * 服务一次只处理一个请求，第二个并发请求回 409；朗读队列本来是一句一句来的，只有手动开着
 * 服务的 WebUI 时才会撞上，等一会儿重试即可。它没有鉴权、没有限速，只监听 127.0.0.1。
 *
 * 和其它引擎一样，这里只负责"文字 → WAV 字节"，不碰队列、不碰播放；失败一律返回
 * { ok: false, error }，绝不抛出去影响气泡。
 */
import { clampInt, clampFloat } from './config.js';
import { wavInfo } from './player.js';

/** 服务默认监听这个地址；配置留空时用它。 */
export const LOCAL_DEFAULT_BASE_URL = 'http://127.0.0.1:8137';

/** 服务端固定 24 kHz 单声道；只在响应没给采样率时用作兜底。 */
const LOCAL_FALLBACK_SAMPLE_RATE = 24000;

/** 撞上"服务正忙"时最多试几次，以及每次之间的等待（毫秒）。 */
export const LOCAL_BUSY_ATTEMPTS = 3;
const LOCAL_BUSY_WAIT_MS = 500;

/** 把配置里的地址收拾成不带结尾斜杠的 http(s) 地址。 */
export function localBaseUrl(cfg = {}) {
  const raw = typeof cfg.localBaseUrl === 'string' ? cfg.localBaseUrl.trim() : '';
  const value = raw || LOCAL_DEFAULT_BASE_URL;
  return value.replace(/\/+$/, '');
}

/** 本机服务不需要密钥：只要能选到它就算"已配置"。 */
export function localStatus(cfg = {}) {
  return { configured: true, from: 'local', candidates: [], endpoint: localBaseUrl(cfg) };
}

/** 裸 PCM（s16le）补 44 字节 RIFF 头。服务回 audio/pcm 时走这里。 */
export function pcmToWav(pcm, sampleRate = LOCAL_FALLBACK_SAMPLE_RATE, channels = 1, bitsPerSample = 16) {
  const bytesPerFrame = (bitsPerSample / 8) * channels;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  header.writeUInt16LE(bytesPerFrame, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 服务是边生成边发的，WAV 头里的 RIFF 与 data 长度写的是占位值 0xFFFFFFFF。
 * Windows 的 Media.SoundPlayer 会因此报"不是有效的波形文件"，所以按实际字节数补上。
 */
export function repairWavSizes(bytes) {
  if (bytes.length < 44) return bytes;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return bytes;
  bytes.writeUInt32LE(bytes.length - 8, 4);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const declared = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    const available = bytes.length - body;
    if (id === 'data') {
      if (declared === 0xFFFFFFFF || declared > available) bytes.writeUInt32LE(available, offset + 4);
      break;
    }
    if (declared === 0xFFFFFFFF || declared > available) break;
    offset = body + declared + (declared % 2);
  }
  return bytes;
}

/** 从错误响应里取一句人话（服务的错误体是 { error: { message } }）。 */
function describeBody(raw, status) {
  try {
    const payload = JSON.parse(raw);
    const detail = payload?.error?.message ?? payload?.error ?? payload?.message;
    if (typeof detail === 'string' && detail.trim()) return `本地服务返回 ${status}：${detail.trim()}`;
  } catch { /* 不是 JSON，按原文截一段 */ }
  const snippet = raw.trim().slice(0, 200);
  return snippet ? `本地服务返回 ${status}：${snippet}` : `本地服务返回 ${status}`;
}

/**
 * 合成一句话，返回 WAV 字节。
 *
 * 返回 { ok: true, bytes, ms, model, voiceId, usage } 或 { ok: false, code, error, retryable }。
 * retryable 表示下次可能成功（服务没起、忙、超时），路由层据此决定是否退回系统语音。
 */
export async function synthesizeLocal(text, cfg = {}, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, code: 'empty-text', error: '朗读文字为空', retryable: false };
  }
  const base = localBaseUrl(cfg);
  const voice = typeof cfg.localVoice === 'string' ? cfg.localVoice.trim() : '';
  const instructions = typeof cfg.localInstruction === 'string' ? cfg.localInstruction.trim() : '';
  const body = {
    input: text,
    response_format: 'wav',
    seed: clampInt(cfg.localSeed, 0, 2147483647, 42),
    cfg_scale: clampFloat(cfg.localCfgScale, 1, 10, 1),
  };
  if (voice) body.voice = voice;
  if (instructions) body.instructions = instructions;

  const timeoutMs = clampInt(cfg.localTimeoutMs, 3000, 300000, 60000);
  const busyWaitMs = Number.isFinite(opts.localBusyWaitMs) ? Number(opts.localBusyWaitMs) : LOCAL_BUSY_WAIT_MS;
  const attempts = Number.isFinite(opts.localBusyAttempts) ? Number(opts.localBusyAttempts) : LOCAL_BUSY_ATTEMPTS;
  const started = Date.now();

  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'audio/wav' },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });

      // 服务一次只念一句：撞上了就等一下再问，别把这一句直接推给系统语音
      if (response.status === 409 && attempt < attempts) {
        await response.body?.cancel().catch(() => {});
        await sleep(busyWaitMs * attempt);
        continue;
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        return {
          ok: false,
          code: `http-${response.status}`,
          error: describeBody(raw, response.status),
          retryable: response.status === 409 || response.status === 429 || response.status >= 500,
        };
      }
      if (contentType.includes('json')) {
        const raw = await response.text().catch(() => '');
        return { ok: false, code: 'bad-content', error: describeBody(raw, response.status), retryable: false };
      }

      let bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) {
        return { ok: false, code: 'empty-audio', error: '本地服务返回了空音频', retryable: true };
      }
      // response_format=wav 时直接是 WAV；老版本或表单那一路回的是裸 PCM，补个头再播
      if (bytes.toString('ascii', 0, 4) !== 'RIFF') {
        const rate = clampInt(response.headers.get('x-sample-rate'), 8000, 48000, LOCAL_FALLBACK_SAMPLE_RATE);
        bytes = pcmToWav(bytes, rate);
      } else {
        bytes = repairWavSizes(bytes);
      }
      const info = wavInfo(bytes);
      if (!info || !info.dataSize || !info.sampleRate) {
        return { ok: false, code: 'invalid-audio', error: '本地服务返回的音频无法识别', retryable: false };
      }
      return {
        ok: true,
        bytes,
        ms: Date.now() - started,
        model: 'breeze-tts-2',
        voiceId: voice || 'design',
        usage: { characters: null, audioMs: info.ms, audioFormat: 'wav', sampleRate: info.sampleRate },
      };
    } catch (err) {
      const timedOut = controller.signal.aborted;
      return {
        ok: false,
        code: timedOut ? 'timeout' : 'network',
        error: timedOut
          ? `本地服务 ${base} 超时（${timeoutMs}ms）`
          : `连不上本地服务 ${base}：${err?.message ?? err}`,
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 一句合成请求的 JSON 体（WAV 与流式两路共用）。 */
function localRequestBody(text, cfg, format) {
  const voice = typeof cfg.localVoice === 'string' ? cfg.localVoice.trim() : '';
  const instructions = typeof cfg.localInstruction === 'string' ? cfg.localInstruction.trim() : '';
  const body = {
    input: text,
    response_format: format,
    seed: clampInt(cfg.localSeed, 0, 2147483647, 42),
    cfg_scale: clampFloat(cfg.localCfgScale, 1, 10, 1),
  };
  if (voice) body.voice = voice;
  if (instructions) body.instructions = instructions;
  return body;
}

/**
 * 边合成边回调：服务生成一块就交给 onChunk，用来跟着气泡念，不等整段合成完。
 *
 * 用 response_format: "pcm"（裸 s16le 单声道，采样率看 X-Sample-Rate），
 * 这样块边界就是音频数据边界，不用再拆 WAV 头。
 *
 * 返回 { ok, bytes, sampleRate, audioMs, ms, model, voiceId } 或 { ok: false, code, error }。
 * 已经吐出去过音频再出错时带 partial: true —— 调用方别把这一句再重念一遍。
 */
export async function synthesizeLocalStream(text, cfg = {}, { onChunk = () => {}, opts = {} } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, code: 'empty-text', error: '朗读文字为空', retryable: false };
  }
  const base = localBaseUrl(cfg);
  const body = localRequestBody(text, cfg, 'pcm');
  const timeoutMs = clampInt(cfg.localTimeoutMs, 3000, 300000, 60000);
  const busyWaitMs = Number.isFinite(opts.localBusyWaitMs) ? Number(opts.localBusyWaitMs) : LOCAL_BUSY_WAIT_MS;
  const attempts = Number.isFinite(opts.localBusyAttempts) ? Number(opts.localBusyAttempts) : LOCAL_BUSY_ATTEMPTS;
  const started = Date.now();

  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'audio/pcm' },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });

      if (response.status === 409 && attempt < attempts) {
        await response.body?.cancel().catch(() => {});
        await sleep(busyWaitMs * attempt);
        clearTimeout(timer);
        continue;
      }
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        clearTimeout(timer);
        return {
          ok: false,
          code: `http-${response.status}`,
          error: describeBody(raw, response.status),
          retryable: response.status === 409 || response.status === 429 || response.status >= 500,
        };
      }
      if (contentType.includes('json')) {
        const raw = await response.text().catch(() => '');
        clearTimeout(timer);
        return { ok: false, code: 'bad-content', error: describeBody(raw, response.status), retryable: false };
      }

      const sampleRate = clampInt(response.headers.get('x-sample-rate'), 8000, 48000, LOCAL_FALLBACK_SAMPLE_RATE);
      let bytes = 0;
      let firstAt = 0;
      try {
        if (!response.body) throw new Error('响应没有音频流');
        for await (const chunk of response.body) {
          if (!chunk?.length) continue;
          if (!firstAt) firstAt = Date.now() - started;
          bytes += chunk.length;
          onChunk(chunk);
        }
      } catch (err) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        return {
          ok: false,
          code: timedOut ? 'timeout' : 'stream-broken',
          error: timedOut
            ? `本地服务合成到一半超时（${timeoutMs}ms）`
            : `本地服务音频流中断：${err?.message ?? err}`,
          bytes,
          audioMs: Math.round((bytes / 2 / sampleRate) * 1000),
          sampleRate,
          partial: bytes > 0,
          retryable: false,
        };
      }
      clearTimeout(timer);
      if (!bytes) {
        return { ok: false, code: 'empty-audio', error: '本地服务返回了空音频', retryable: true };
      }
      const audioMs = Math.round((bytes / 2 / sampleRate) * 1000);
      return {
        ok: true,
        bytes,
        sampleRate,
        audioMs,
        firstAudioMs: firstAt,
        ms: Date.now() - started,
        model: 'breeze-tts-2',
        voiceId: body.voice || 'design',
        usage: { characters: null, audioMs, audioFormat: 'pcm', sampleRate },
      };
    } catch (err) {
      clearTimeout(timer);
      const timedOut = controller.signal.aborted;
      return {
        ok: false,
        code: timedOut ? 'timeout' : 'network',
        error: timedOut
          ? `本地服务 ${base} 超时（${timeoutMs}ms）`
          : `连不上本地服务 ${base}：${err?.message ?? err}`,
        retryable: true,
      };
    }
  }
}

/** 读服务的健康信息与音色表；探测用，不合成。 */
export async function probeLocal(cfg = {}, { timeoutMs = 1500 } = {}) {
  const base = localBaseUrl(cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const health = await fetch(`${base}/health`, { signal: controller.signal, redirect: 'error' });
    if (!health.ok) return { ok: false, base, error: `健康检查返回 ${health.status}` };
    const info = await health.json().catch(() => ({}));
    const voices = await listLocalVoices(cfg, { timeoutMs: 0 }).catch((err) => ({ ok: false, error: err?.message ?? String(err) }));
    return {
      ok: true,
      base,
      sampleRate: Number(info?.sample_rate) || null,
      wsPort: Number(info?.ws_port) || null,
      voices: voices.voices ?? [],
      voicesError: voices.ok ? null : voices.error,
    };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      base,
      error: timedOut ? `健康检查超时（${timeoutMs}ms）` : `连不上 ${base}：${err?.message ?? err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 服务里可用的音色（保存的与缓存的）。 */
export async function listLocalVoices(cfg = {}, { timeoutMs = 3000 } = {}) {
  const base = localBaseUrl(cfg);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(`${base}/v1/voices`, {
      signal: controller?.signal,
      redirect: 'error',
    });
    if (!response.ok) return { ok: false, voices: [], error: `音色列表返回 ${response.status}` };
    const payload = await response.json();
    const voices = (Array.isArray(payload) ? payload : []).filter((v) => v && typeof v.id === 'string');
    return { ok: true, voices };
  } catch (err) {
    return { ok: false, voices: [], error: `读取音色列表失败：${err?.message ?? err}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
