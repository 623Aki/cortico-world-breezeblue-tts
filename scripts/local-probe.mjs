/** 本机 breeze-tts-2 服务的诊断：默认报状态；--voices 列音色；--speak 合成（--play 播出来）；--stream 边走边播看同步延迟。 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { petVoiceDefaults } from '../src/index.js';
import { resolveDataDir } from '../src/events.js';
import { localBaseUrl, probeLocal, listLocalVoices, synthesizeLocal, synthesizeLocalStream } from '../src/local.js';
import { createAudioHost } from '../src/audio-host.js';
import { playWav } from '../src/player.js';

const args = process.argv.slice(2);
const value = (name, fallback = '') => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[i + 1];
};

try {
  // 传了 --data 就用那份部署里的配置，否则用包内默认值
  const deployment = value('--data', '') || resolveDataDir() || '';
  let saved = {};
  if (deployment) {
    const dataDir = resolve(deployment);
    try { saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).worlds?.['breezeblue-tts'] ?? {}; }
    catch (err) { if (err.code !== 'ENOENT') throw new Error(`Cannot read config.json: ${err.message}`); }
  }
  const cfg = { ...petVoiceDefaults(), cloudProvider: 'local', ...saved };
  if (args.includes('--base')) cfg.localBaseUrl = value('--base');
  if (args.includes('--voice')) cfg.localVoice = value('--voice');
  if (args.includes('--instruction')) cfg.localInstruction = value('--instruction');
  if (args.includes('--seed')) cfg.localSeed = Number(value('--seed'));

  if (args.includes('--voices')) {
    const result = await listLocalVoices(cfg);
    if (!result.ok) throw new Error(result.error);
    console.log(JSON.stringify({
      base: localBaseUrl(cfg),
      voices: result.voices.map((v) => ({ id: v.id, seconds: v.seconds, saved: v.saved === true, description: v.description })),
    }, null, 2));
  } else if (args.includes('--stream')) {
    // 和扩展里真实朗读走同一条路：PCM 流 + 常驻播放进程，首音延迟一眼可见
    const host = createAudioHost({ log: (l, m) => console.error(`[${l}] ${m}`) });
    try {
      const boot = await host.warm(24000);
      if (!boot.ok) throw new Error(boot.error);
      const began = Date.now();
      const streamed = await host.speakStream(24000, (feed) => synthesizeLocalStream(value('--text', '你好。'), cfg, { onChunk: feed }));
      if (!streamed.bytes) throw new Error(streamed.error || '没有收到音频');
      console.log(JSON.stringify({
        ok: streamed.ok, warmMs: host.status().readyMs, firstAudioMs: streamed.firstAudioMs,
        audioMs: streamed.audioMs, totalMs: Date.now() - began, bytes: streamed.bytes, error: streamed.error,
      }));
    } finally {
      await host.dispose();
    }
  } else if (args.includes('--speak')) {
    const result = await synthesizeLocal(value('--text', '你好。'), cfg);
    if (!result.ok) throw new Error(result.error);
    console.log(JSON.stringify({
      ok: true, base: localBaseUrl(cfg), voice: result.voiceId, bytes: result.bytes.length, ms: result.ms, usage: result.usage,
    }));
    if (args.includes('--play')) {
      const played = await playWav(result.bytes, cfg);
      if (!played.ok) throw new Error(played.error);
      console.log(JSON.stringify({ played: true, ms: played.ms, sampleRate: played.sampleRate }));
    }
  } else {
    const probe = await probeLocal(cfg);
    console.log(JSON.stringify({
      base: localBaseUrl(cfg),
      reachable: probe.ok === true,
      sampleRate: probe.sampleRate ?? null,
      wsPort: probe.wsPort ?? null,
      voices: probe.voices?.length ?? 0,
      voice: cfg.localVoice || null,
      error: probe.ok === true ? null : probe.error,
    }, null, 2));
    if (probe.ok !== true) process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
