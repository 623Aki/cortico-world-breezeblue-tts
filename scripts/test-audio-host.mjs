import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createAudioHost, pcmDurationMs, pcmFrame } from '../src/audio-host.js';

/** 假进程：stdout 说 ready/drained，stdin 按帧切开记录。 */
function fakeChild({ ready = true, failOpen = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.frames = [];
  let pending = Buffer.alloc(0);
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const len = pending.readInt32LE(0);
        // 0 与 1 是控制帧，只有 4 字节头，没有负载
        if (len === 0 || len === 1) {
          pending = pending.subarray(4);
          child.frames.push(Buffer.alloc(0));
          if (len === 0) setTimeout(() => child.stdout.write('drained\n'), 5);
          else setTimeout(() => child.stdout.write('stopped\n'), 5);
          continue;
        }
        if (pending.length < 4 + len) break;
        child.frames.push(pending.subarray(4, 4 + len));
        pending = pending.subarray(4 + len);
      }
      cb();
    },
    final(cb) { cb(); },
  });
  child.kill = () => setImmediate(() => child.emit('close', 0));
  if (failOpen) {
    setTimeout(() => {
      child.stderr.write('compile: 没有 csc\n');
      child.emit('close', 2);
    }, 5);
  } else if (ready) {
    setTimeout(() => child.stdout.write('ready\n'), 5);
  }
  return child;
}

const PCM = Buffer.alloc(4800); // 0.1 秒 24k/16bit 单声道

try {
  await test('frames are [int32 length][pcm] and duration comes from the byte count', () => {
    const framed = pcmFrame(PCM);
    assert.equal(framed.length, PCM.length + 4);
    assert.equal(framed.readInt32LE(0), PCM.length);
    assert.deepEqual(framed.subarray(4), PCM);
    assert.equal(pcmDurationMs(48000, 24000), 1000);
    assert.equal(pcmDurationMs(2400, 24000), 50);
    assert.equal(pcmDurationMs(96000, 24000, 2), 1000);
  });

  await test('the player reuses one process and reports first-audio latency', async () => {
    const spawned = [];
    const host = createAudioHost({ spawnFn: () => { const c = fakeChild(); spawned.push(c); return c; } });
    const boot = await host.warm(24000);
    assert.equal(boot.ok, true);
    assert.equal(host.streaming, true);

    let fed = 0;
    const res = await host.speakStream(24000, (feed) => {
      feed(PCM);
      feed(PCM);
      fed += 2;
      return { ok: true };
    });
    assert.equal(res.ok, true);
    assert.equal(res.bytes, PCM.length * 2);
    assert.equal(res.audioMs, 200);
    assert.equal(fed, 2);
    // 两帧 + 一个结束帧（长度 0）
    assert.equal(spawned[0].frames.length, 3);
    assert.equal(spawned[0].frames[2].length, 0);
    await host.dispose();
  });

  await test('a producer that yields nothing never waits for playback', async () => {
    const host = createAudioHost({ spawnFn: () => fakeChild() });
    await host.warm(24000);
    const res = await host.speakStream(24000, () => ({ ok: false, error: '连不上本地服务' }));
    assert.equal(res.ok, false);
    assert.equal(res.audioMs, 0);
    assert.match(res.error, /连不上本地服务/);
    await host.dispose();
  });

  await test('a process that cannot start is marked broken and never respawned', async () => {
    let spawns = 0;
    const host = createAudioHost({ spawnFn: () => { spawns += 1; return fakeChild({ failOpen: true }); } });
    const boot = await host.warm(24000);
    assert.equal(boot.ok, false);
    assert.equal(host.broken, true);
    assert.match(host.status().lastError, /csc|compile/);

    const res = await host.speakStream(24000, () => ({ ok: true }));
    assert.equal(res.ok, false);
    assert.equal(spawns, 1, '不该为每一句重试启动');
    await host.dispose();
  });

  await test('abort tells the player to stop right away', async () => {
    const child = fakeChild();
    const host = createAudioHost({ spawnFn: () => child });
    await host.warm(24000);
    const res = await host.abort();
    assert.equal(res.ok, true);
    assert.equal(child.frames.length, 1);
    assert.equal(child.frames[0].length, 0);
    await host.dispose();
  });
} finally {
  // 假进程没有真句柄，不需要额外清理
}
