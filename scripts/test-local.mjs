import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeLocal, synthesizeLocalStream, localBaseUrl, pcmToWav, repairWavSizes, LOCAL_DEFAULT_BASE_URL } from '../src/local.js';
import { wavInfo } from '../src/player.js';
import { createSpeech, probeEngines } from '../src/speech.js';
import { petVoiceDefaults } from '../src/index.js';

const realFetch = globalThis.fetch;

/** 一段 0.1 秒 24 kHz 单声道 WAV。 */
function makeWav({ sampleRate = 24000, samples = 2400 } = {}) {
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const audio = (bytes = makeWav(), headers = {}) =>
  new Response(bytes, { status: 200, headers: { 'content-type': 'audio/wav', ...headers } });
const failure = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } });

const cfg = () => ({ ...petVoiceDefaults(), cloudProvider: 'local' });

try {
  await test('local request is OpenAI-shaped JSON asking for wav', async () => {
    let seen;
    globalThis.fetch = async (url, init) => { seen = { url, init }; return audio(); };
    const result = await synthesizeLocal('你好', { ...cfg(), localVoice: 'ojou', localInstruction: '平静地说', localCfgScale: 2, localSeed: 7 });
    assert.equal(result.ok, true);
    assert.equal(seen.url, `${LOCAL_DEFAULT_BASE_URL}/v1/audio/speech`);
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers['content-type'], 'application/json');
    const body = JSON.parse(seen.init.body);
    assert.deepEqual(body, {
      input: '你好',
      response_format: 'wav',
      seed: 7,
      cfg_scale: 2,
      voice: 'ojou',
      instructions: '平静地说',
    });
  });

  await test('an empty voice and instruction are left out so the service designs one', async () => {
    let body;
    globalThis.fetch = async (url, init) => { body = JSON.parse(init.body); return audio(); };
    await synthesizeLocal('设计一个声音', cfg());
    assert.equal('voice' in body, false);
    assert.equal('instructions' in body, false);
    assert.equal(body.response_format, 'wav');
  });

  await test('a WAV response passes through with its duration', async () => {
    globalThis.fetch = async () => audio();
    const result = await synthesizeLocal('你好', cfg());
    assert.equal(result.ok, true);
    assert.equal(result.bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(result.usage.sampleRate, 24000);
    assert.equal(result.usage.audioMs, 100);
    assert.equal(result.voiceId, 'design');
  });

  await test('placeholder stream sizes in the WAV header are filled in', async () => {
    const streamed = makeWav();
    streamed.writeUInt32LE(0xFFFFFFFF, 4);
    streamed.writeUInt32LE(0xFFFFFFFF, 40);
    globalThis.fetch = async () => audio(streamed);
    const result = await synthesizeLocal('你好', cfg());
    assert.equal(result.ok, true);
    assert.equal(result.bytes.readUInt32LE(4), result.bytes.length - 8);
    assert.equal(result.bytes.readUInt32LE(40), result.bytes.length - 44);
    assert.equal(repairWavSizes(Buffer.alloc(10)).length, 10);
  });

  await test('raw PCM gets a RIFF header at the rate the service reports', async () => {
    const pcm = Buffer.alloc(2400, 1);
    globalThis.fetch = async () => new Response(pcm, {
      status: 200,
      headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le' },
    });
    const result = await synthesizeLocal('你好', cfg());
    assert.equal(result.ok, true);
    const info = wavInfo(result.bytes);
    assert.equal(info.sampleRate, 24000);
    assert.equal(info.channels, 1);
    assert.equal(info.dataSize, pcm.length);
    assert.equal(info.ms, 50);
  });

  await test('pcmToWav writes a readable 16 bit mono header', () => {
    const info = wavInfo(pcmToWav(Buffer.alloc(480), 16000));
    assert.equal(info.sampleRate, 16000);
    assert.equal(info.bitsPerSample, 16);
    assert.equal(info.bytesPerFrame, 2);
    assert.equal(info.ms, 15);
  });

  await test('a busy service is retried instead of falling back at once', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1 ? failure(409, 'busy') : audio();
    };
    const result = await synthesizeLocal('你好', cfg(), { localBusyWaitMs: 0 });
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
  });

  await test('a busy service that stays busy gives up as retryable', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return failure(409, 'busy'); };
    const result = await synthesizeLocal('你好', cfg(), { localBusyWaitMs: 0, localBusyAttempts: 3 });
    assert.equal(calls, 3);
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error, /busy/);
  });

  await test('an unknown voice reports the service message and is not retried', async () => {
    globalThis.fetch = async () => failure(404, 'unknown voice: nope');
    const result = await synthesizeLocal('你好', { ...cfg(), localVoice: 'nope' });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error, /unknown voice: nope/);
  });

  await test('an unreachable service is retryable and names the address', async () => {
    globalThis.fetch = async () => { throw new Error('fetch failed: ECONNREFUSED'); };
    const result = await synthesizeLocal('你好', { ...cfg(), localBaseUrl: 'http://127.0.0.1:8199/' });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error, /127\.0\.0\.1:8199/);
  });

  await test('a service that never answers is reported as a timeout', async () => {
    globalThis.fetch = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const result = await synthesizeLocal('你好', { ...cfg(), localTimeoutMs: 3000 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'timeout');
    assert.equal(result.retryable, true);
  });

  await test('the base url keeps its path but loses trailing slashes', () => {
    assert.equal(localBaseUrl({ localBaseUrl: '  http://127.0.0.1:9000/tts// ' }), 'http://127.0.0.1:9000/tts');
    assert.equal(localBaseUrl({}), LOCAL_DEFAULT_BASE_URL);
  });

  await test('speech routes to the local engine without a key and plays its bytes', async () => {
    const wav = makeWav();
    globalThis.fetch = async () => audio(wav);
    let played;
    const speech = createSpeech({
      getConfig: cfg,
      engines: {
        speakSapi: async () => ({ ok: true, ms: 1 }),
        playWav: async (bytes) => { played = bytes; return { ok: true, ms: 100 }; },
      },
    });
    const result = await speech.speak('你好');
    assert.equal(result.ok, true);
    assert.equal(result.engine, 'local');
    assert.deepEqual(Buffer.from(played), wav);
    const status = speech.status();
    assert.equal(status.provider, 'local');
    assert.equal(status.cloudReady, true);
    assert.equal(status.endpoint, LOCAL_DEFAULT_BASE_URL);
  });

  await test('a local failure falls back to the system voice', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    let system = 0;
    const speech = createSpeech({
      getConfig: cfg,
      engines: {
        speakSapi: async () => { system += 1; return { ok: true, ms: 1 }; },
        playWav: async () => ({ ok: true, ms: 1 }),
      },
    });
    const result = await speech.speak('你好');
    assert.equal(result.engine, 'sapi');
    assert.equal(result.fellBack, true);
    assert.equal(result.fallbackReason, 'cloud-failed');
    assert.equal(system, 1);
  });

  await test('streaming asks for pcm and hands chunks over as they arrive', async () => {
    let body;
    globalThis.fetch = async (url, init) => {
      body = JSON.parse(init.body);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.alloc(4800, 1)));
          controller.enqueue(new Uint8Array(Buffer.alloc(2400, 2)));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' },
      });
    };
    const seen = [];
    const res = await synthesizeLocalStream('你好', { ...cfg(), localVoice: 'ojou' }, { onChunk: (c) => seen.push(c.length) });
    assert.equal(body.response_format, 'pcm');
    assert.equal(body.voice, 'ojou');
    assert.equal(res.ok, true);
    assert.equal(res.sampleRate, 24000);
    assert.equal(res.bytes, 7200);
    assert.equal(res.audioMs, 150);
    assert.deepEqual(seen, [4800, 2400]);
  });

  await test('a busy local service makes the streaming request wait and retry', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response('{"error":"busy"}', { status: 409 });
      return new Response(new Uint8Array(Buffer.alloc(2400, 3)), {
        status: 200,
        headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' },
      });
    };
    const res = await synthesizeLocalStream('你好', cfg(), { opts: { localBusyWaitMs: 1, localBusyAttempts: 2 } });
    assert.equal(calls, 2);
    assert.equal(res.ok, true);
    assert.equal(res.audioMs, 50);
  });

  await test('probeEngines reports the local service when it is the chosen provider', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok', sample_rate: 24000, ws_port: 8138 }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify([{ id: 'ojou', seconds: 13.04, saved: true }]), { headers: { 'content-type': 'application/json' } });
    };
    const report = await probeEngines(cfg());
    assert.equal(report.cloud.provider, 'local');
    assert.equal(report.cloud.ready, true);
    assert.equal(report.local.ok, true);
    assert.equal(report.local.sampleRate, 24000);
    assert.equal(report.local.voices.length, 1);
  });
} finally {
  globalThis.fetch = realFetch;
}
