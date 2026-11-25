import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { petVoiceDefaults } from '../src/index.js';
import {
  prepareVoiceLibrary, refreshVoiceLibrary, localVoiceOptions, localVoiceOptionsFromDeployment,
  rememberVoices, voiceCount, voiceLabel,
} from '../src/voice-library.js';

const realFetch = globalThis.fetch;

const VOICES = [
  {
    id: 'ojou', seconds: 13.04, saved: true,
    description: '知性大小姐音（加固版）：成年女声，清亮偏冷、语调从容，语速偏快字字清楚。',
    metadata: { persona: 'ojou-sama' },
  },
  {
    id: 'tsun', seconds: 14.56, saved: true,
    description: '傲娇少女音（加固版·快语速）：动漫少女，声线偏细偏甜、音调偏高。',
    metadata: { persona: 'tsun' },
  },
];

/** 每个用例用自己的 base，免得 15 秒节流与缓存互相干扰。 */
const cfgAt = (port, extra = {}) => ({
  ...petVoiceDefaults(),
  localBaseUrl: `http://127.0.0.1:${port}`,
  ...extra,
});

function stubFetch(voices = VOICES, { status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: 'nope' } }), {
        status, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(voices), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

try {
  await test('a label puts the id first, then the short description and the reference length', () => {
    assert.equal(voiceLabel(VOICES[0]), 'ojou · 知性大小姐音（加固版） · 13.0s');
    // 没有 description 时用 metadata.persona 兜底
    assert.equal(voiceLabel({ id: 'x', metadata: { persona: 'butler' } }), 'x · butler');
    // 太长的说明截断，不让一个下拉项换行
    const long = voiceLabel({ id: 'y', description: '一'.repeat(60) });
    assert.equal(long.startsWith('y · '), true);
    assert.equal(long.endsWith('…'), true);
    assert.ok(long.length <= 34, `label too long: ${long}`);
  });

  await test('refresh fills the options: empty first, then every voice in the library', async () => {
    const calls = stubFetch();
    const cfg = cfgAt(9101);
    await refreshVoiceLibrary(cfg, { force: true });
    const options = localVoiceOptions(cfg, 'zh', { refresh: false });
    assert.deepEqual(calls, ['http://127.0.0.1:9101/v1/voices']);
    assert.equal(options.length, 3);
    assert.equal(options[0].value, '');
    assert.match(options[0].label, /现场设计/);
    assert.deepEqual(options.slice(1).map((o) => o.value), ['ojou', 'tsun']);
    assert.match(options[1].label, /^ojou · 知性大小姐音/);
    assert.equal(voiceCount(cfg), 2);
  });

  await test('an empty library still offers the design-from-instruction entry', async () => {
    stubFetch([]);
    const cfg = cfgAt(9102);
    await refreshVoiceLibrary(cfg, { force: true });
    const options = localVoiceOptions(cfg, 'zh', { refresh: false });
    assert.equal(options.length, 1);
    assert.equal(options[0].value, '');
    assert.match(options[0].label, /现场设计/);
  });

  await test('a value stored in config but missing from the library stays selectable', async () => {
    stubFetch();
    const cfg = cfgAt(9103, { localVoice: 'ojou-old' });
    await refreshVoiceLibrary(cfg, { force: true });
    const options = localVoiceOptions(cfg, 'zh', { refresh: false });
    assert.equal(options[0].value, '');
    assert.equal(options[1].value, 'ojou-old');
    assert.match(options[1].label, /不在当前音色库/);
  });

  await test('a failed refresh keeps the previous list and never throws', async () => {
    stubFetch();
    const cfg = cfgAt(9104);
    await refreshVoiceLibrary(cfg, { force: true });
    assert.equal(voiceCount(cfg), 2);

    stubFetch(VOICES, { status: 500 });
    const entry = await refreshVoiceLibrary(cfg, { force: true });
    assert.equal(voiceCount(cfg), 2);
    assert.match(entry.error, /音色列表返回 500/);
    assert.equal(localVoiceOptions(cfg, 'zh', { refresh: false }).length, 3);
  });

  await test('two probes in a row only hit the service once; force always asks', async () => {
    const calls = stubFetch();
    const cfg = cfgAt(9105);
    await refreshVoiceLibrary(cfg);
    await refreshVoiceLibrary(cfg);
    assert.equal(calls.length, 1);
    await refreshVoiceLibrary(cfg, { force: true });
    assert.equal(calls.length, 2);
  });

  await test('options from a dead service degrade to the hint, not an error', async () => {
    globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
    const cfg = cfgAt(9106);
    const options = localVoiceOptions(cfg, 'zh');
    assert.equal(options.length, 1);
    assert.equal(options[0].value, '');
    await new Promise((r) => setTimeout(r, 20)); // 让后台刷新自己失败掉
    assert.equal(voiceCount(cfg), 0);
  });

  await test('the library survives a restart through the deployment directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbt-voices-'));
    try {
      stubFetch();
      const cfg = cfgAt(9107);
      prepareVoiceLibrary(dir);
      await refreshVoiceLibrary(cfg, { force: true });
      const saved = JSON.parse(readFileSync(join(dir, 'voice-library.json'), 'utf8'));
      assert.deepEqual(saved['http://127.0.0.1:9107'].voices.map((v) => v.id), ['ojou', 'tsun']);

      // 换一份模块实例（模拟重启），不联网也应该读到上次的结果
      globalThis.fetch = async () => { throw new Error('should not fetch'); };
      const fresh = await import(`../src/voice-library.js?restart=${Date.now()}`);
      fresh.prepareVoiceLibrary(dir);
      const options = fresh.localVoiceOptions(cfg, 'zh', { refresh: false });
      assert.deepEqual(options.map((o) => o.value), ['', 'ojou', 'tsun']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('probe results do not overwrite a richer cached list', () => {
    const cfg = cfgAt(9108);
    rememberVoices('http://127.0.0.1:9108', VOICES);
    assert.equal(voiceCount(cfg), 2);
    // 老版本服务只回 id：别把带说明的那份盖掉
    rememberVoices('http://127.0.0.1:9108', [{ id: 'ojou' }, { id: 'tsun' }]);
    assert.match(localVoiceOptions(cfg, 'zh', { refresh: false })[1].label, /知性大小姐音/);
  });

  await test('the panel options follow the port stored in the deployment config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbt-deploy-'));
    const prevHome = process.env.CORTICO_HOME;
    try {
      mkdirSync(join(dir, 'runs'));
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        worlds: { 'breezeblue-tts': { localBaseUrl: 'http://127.0.0.1:9110', localVoice: 'tsun' } },
      }));
      process.env.CORTICO_HOME = dir;
      const calls = stubFetch();
      // 第一次只有空项：刷新在后台跑
      const first = localVoiceOptionsFromDeployment('zh');
      assert.equal(first[0].value, '');
      await new Promise((r) => setTimeout(r, 50));
      const second = localVoiceOptionsFromDeployment('zh');
      assert.deepEqual(second.map((o) => o.value), ['', 'ojou', 'tsun']);
      assert.equal(calls[0], 'http://127.0.0.1:9110/v1/voices');
    } finally {
      if (prevHome === undefined) delete process.env.CORTICO_HOME;
      else process.env.CORTICO_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
} finally {
  globalThis.fetch = realFetch;
}
