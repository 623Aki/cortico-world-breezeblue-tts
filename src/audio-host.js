/**
 * 常驻音频播放进程（Windows waveOut）。
 *
 * 为什么要它：原来的播法是"合成完 → 写 WAV → 起一个 PowerShell 播完就退"。每次起进程
 * 要 1 秒以上，长句还要等整段合成（实测 8 秒语音要 4.8 秒才合成完），气泡文字早就出来了，
 * 声音才跟上——就是"文字先出现"的根因。
 *
 * 现在这个进程在挂载时常驻，收到 PCM 就立刻喂给 waveOut：第一块音频到达（实测 300 毫秒
 * 左右）就能出声，进程启动成本只在启动时付一次。
 *
 * 协议见 scripts/pcm-sink.ps1。这里只管进程、分帧和"这一句播完了没"。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 播放器脚本路径。 */
export const SINK_SCRIPT = join(HERE, '..', 'scripts', 'pcm-sink.ps1');

const PS_EXE = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

/** 启动（含编译 C#）最多等这么久；慢机器上编译要一两秒。 */
const START_TIMEOUT_MS = 25_000;

/** 结束帧之后等"播完"的余量：声音有多长就等多久，再加这么多。 */
const DRAIN_SLACK_MS = 5000;

/** 单帧上限，和服务那边的分块大小对得上就行。 */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** 按 PCM 字节数算时长（毫秒）。 */
export function pcmDurationMs(bytes, sampleRate, channels = 1, bits = 16) {
  const bytesPerFrame = Math.max(1, (bits / 8) * channels);
  return Math.round((bytes / bytesPerFrame / Math.max(1, sampleRate)) * 1000);
}

/** 音频帧：[4 字节小端长度][PCM]；长度 0 = 这一句结束，1 = 立刻停。 */
export function pcmFrame(pcm) {
  const header = Buffer.alloc(4);
  header.writeInt32LE(pcm.length, 0);
  return Buffer.concat([header, pcm]);
}

/**
 * @param log     (level, message) => void，进程异常时记一笔
 * @param spawnFn 测试用注入
 */
export function createAudioHost({ log = () => {}, spawnFn = spawn, scriptPath = SINK_SCRIPT } = {}) {
  let child = null;
  let lines = null;
  let sampleRate = 0;
  let starting = null;
  let ready = false;
  /** 报过 ready 的那个进程：用它区分"起不来"和"播完正常退出/换采样率"。 */
  let readyFor = null;
  let closedReason = '';
  let lastError = '';
  let startedAt = 0;
  let readyMs = 0;
  let fedBytes = 0;
  let drainWaiter = null;
  let stopWaiter = null;
  /** 起不来（没 PowerShell、Add-Type 被挡、编译失败）就一直用旧的整段播法，别每句都重试。 */
  let broken = false;

  const settle = (kind, value) => {
    const waiter = kind === 'drained' ? drainWaiter : stopWaiter;
    if (!waiter) return;
    if (kind === 'drained') drainWaiter = null;
    else stopWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  };

  const shutdown = (why) => {
    closedReason = why;
    ready = false;
    try { lines?.close(); } catch { /* 已关 */ }
    try { child?.stdin?.end(); } catch { /* 已关 */ }
    try { child?.kill(); } catch { /* 已退 */ }
    child = null;
    starting = null;
    settle('drained', { ok: false, error: why });
    settle('stopped', { ok: false, error: why });
  };

  function onLine(line) {
    const text = line.trim();
    if (!text) return;
    if (text === 'ready') {
      ready = true;
      readyFor = child;
      readyMs = Date.now() - startedAt;
      return;
    }
    if (text === 'drained') { settle('drained', { ok: true }); return; }
    if (text === 'stopped') { settle('stopped', { ok: true }); return; }
    if (text.startsWith('error') || text.startsWith('write:') || text.startsWith('bad frame')) {
      lastError = text;
      log('warn', `音频播放进程报告：${text}`);
    }
  }

  /** 起进程（或换采样率时重起），等它报 ready。 */
  function ensure(rate) {
    const want = Math.max(8000, Math.min(48000, Math.round(rate || 24000)));
    if (broken) return Promise.resolve({ ok: false, error: lastError || '音频播放进程不可用' });
    if (child && ready && sampleRate === want) return Promise.resolve({ ok: true, sampleRate });
    if (child && sampleRate !== want) shutdown('换采样率');
    if (starting) return starting;

    const started = Date.now();
    starting = new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        starting = null;
        resolve(result);
      };
      let proc;
      try {
        proc = spawnFn(PS_EXE, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          '-SampleRate', String(want),
        ], { windowsHide: true });
      } catch (err) {
        broken = true;
        lastError = `起播放进程失败：${err?.message ?? err}`;
        done({ ok: false, error: lastError });
        return;
      }
      child = proc;
      sampleRate = want;
      startedAt = started;

      const timer = setTimeout(() => {
        broken = true;
        lastError = `播放进程 ${START_TIMEOUT_MS}ms 没就绪`;
        shutdown(lastError);
        done({ ok: false, error: lastError });
      }, START_TIMEOUT_MS);

      let stderr = '';
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (d) => { stderr = `${stderr}${d}`.slice(-800); });
      lines = createInterface({ input: proc.stdout });
      lines.on('line', onLine);
      proc.on('error', (err) => {
        broken = true;
        lastError = err?.message ?? String(err);
        shutdown(lastError);
        done({ ok: false, error: lastError });
      });
      proc.on('close', (code) => {
        if (readyFor !== proc) {
          // 没就绪就退了：编译失败或没有音频设备。别每句都重试。
          broken = true;
          lastError = stderr.trim().split('\n').pop() || `播放进程退出 ${code}`;
        }
        if (!ready || closedReason === '') closedReason = stderr.trim().split('\n').pop() || `exit ${code}`;
        // 正常退出（dispose）不记 warn
        if (child === proc) shutdown(closedReason || `exit ${code}`);
        done({ ok: false, error: lastError || `exit ${code}` });
      });

      const waitReady = setInterval(() => {
        if (ready && child === proc) {
          clearInterval(waitReady);
          done({ ok: true, sampleRate: want });
        }
      }, 15);
      proc.on('close', () => clearInterval(waitReady));
    });
    return starting;
  }

  /** 这一句发完了，等设备真的播完。 */
  function finish(audioMs = 0) {
    if (!child || !ready) return Promise.resolve({ ok: false, error: lastError || '播放进程不在' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        lastError = '等播放结束超时';
        shutdown(lastError);
        resolve({ ok: false, error: lastError });
      }, Math.max(2000, audioMs) + DRAIN_SLACK_MS);
      drainWaiter = { resolve, timer };
      try {
        child.stdin.write(Buffer.from([0, 0, 0, 0]));
      } catch (err) {
        clearTimeout(timer);
        drainWaiter = null;
        resolve({ ok: false, error: err?.message ?? String(err) });
      }
    });
  }

  return {
    /** 现在能不能流式播（进程在、就绪）。 */
    get streaming() { return Boolean(child && ready); },
    /** 起不来过：调用方改用整段播法，别再喂它。 */
    get broken() { return broken; },
    get sampleRate() { return sampleRate; },
    status: () => ({ streaming: Boolean(child && ready), broken, sampleRate, readyMs, fedBytes, lastError, closedReason }),

    /** 提前把进程拉起来，第一句就不用等启动。 */
    warm(rate = 24000) { return ensure(rate); },

    /**
     * 一整句的流式播放：producer(feed) 里每来一块就 feed，结束后等播完。
     * 返回 { ok, bytes, sampleRate, audioMs, firstAudioMs, error, partial }。
     * 调用方负责串行（队列已经保证了）。
     */
    async speakStream(rate, producer) {
      const boot = await ensure(rate);
      if (!boot.ok) return { ok: false, error: boot.error };
      let bytes = 0;
      let firstAt = 0;
      const began = Date.now();
      const feed = (chunk) => {
        if (!chunk?.length) return;
        if (!firstAt) firstAt = Date.now() - began;
        fedBytes += chunk.length;
        bytes += chunk.length;
        try {
          child?.stdin?.write(pcmFrame(chunk));
        } catch (err) {
          lastError = `写音频失败：${err?.message ?? err}`;
        }
      };
      let produced;
      try {
        produced = await producer(feed);
      } catch (err) {
        produced = { ok: false, error: err?.message ?? String(err) };
      }
      if (!bytes) {
        // 一块都没出来：不用等 drained，直接收摊
        return { ok: false, error: produced?.error ?? '没有收到音频', audioMs: 0 };
      }
      const drained = await finish(pcmDurationMs(bytes, sampleRate));
      return {
        ok: drained.ok,
        bytes,
        sampleRate,
        audioMs: pcmDurationMs(bytes, sampleRate),
        firstAudioMs: firstAt,
        error: drained.ok ? (produced?.ok === false ? produced.error : null) : drained.error,
        partial: produced?.ok === false,
      };
    },

    finish,

    /** 打断当前播放。 */
    abort() {
      if (!child || !ready) return Promise.resolve({ ok: true, skipped: true });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          shutdown('停止超时');
          resolve({ ok: false, error: '停止超时' });
        }, 3000);
        stopWaiter = { resolve, timer };
        try {
          child.stdin.write(Buffer.from([1, 0, 0, 0]));
        } catch (err) {
          clearTimeout(timer);
          stopWaiter = null;
          resolve({ ok: false, error: err?.message ?? String(err) });
        }
      });
    },

    dispose() {
      shutdown('dispose');
      return Promise.resolve();
    },
  };
}
