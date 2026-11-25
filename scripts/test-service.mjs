/**
 * 服务进程管家的测试：全用假进程与假 /health，不起真服务、不碰网卡。
 *
 * 覆盖的是这台机器上最容易出错的地方：路径怎么算、参数怎么拼、已经在跑时别再起一个、
 * 起不来时能不能说清楚原因、停的时候是不是只动自己起的那个。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalService, isAlive, resolveLaunch, splitArgs, splitBaseUrl } from '../src/service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假进程：只要 stdout 能 .on，exit/kill 能触发就算够用。 */
function fakeProcess(pid = 4321) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

/** 假 /health：前 failTimes 次连不上，之后返回就绪。 */
function fakeFetch({ failTimes = 0, sampleRate = 24000 } = {}) {
  let n = 0;
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    n += 1;
    if (n <= failTimes) throw new Error('connect ECONNREFUSED');
    return {
      ok: true,
      json: async () => ({ status: 'ok', sample_rate: sampleRate, ws_port: 8138 }),
    };
  };
  fn.calls = calls;
  return fn;
}

test('splitBaseUrl 认地址与端口', () => {
  assert.deepEqual(splitBaseUrl('http://127.0.0.1:8137'), { host: '127.0.0.1', port: 8137 });
  assert.deepEqual(splitBaseUrl('http://localhost:9000/'), { host: 'localhost', port: 9000 });
  assert.deepEqual(splitBaseUrl(''), { host: '127.0.0.1', port: 8137 });
  assert.deepEqual(splitBaseUrl('127.0.0.1:8138'), { host: '127.0.0.1', port: 8138 });
});

test('splitArgs 认引号，不吃空串', () => {
  assert.deepEqual(splitArgs('--chunk-max 40'), ['--chunk-max', '40']);
  assert.deepEqual(splitArgs('--a "x y" --b'), ['--a', 'x y', '--b']);
  assert.deepEqual(splitArgs("--a 'x y'"), ['--a', 'x y']);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('   '), []);
});

test('resolveLaunch 拼出完整命令，端口来自服务地址', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-launch-'));
  try {
    const exe = join(dir, 'breeze-server.exe');
    const model = join(dir, 'x.gguf');
    writeFileSync(exe, '');
    writeFileSync(model, '');
    const out = resolveLaunch({
      localBaseUrl: 'http://127.0.0.1:8139',
      localServiceExe: exe,
      localServiceModel: model,
      localServiceArgs: '--chunk-max 40 --verbose',
    }, { dataDir: dir });
    assert.equal(out.ok, true);
    assert.equal(out.port, 8139);
    assert.deepEqual(out.args.slice(0, 6), [model, '--host', '127.0.0.1', '--port', '8139', '--webui']);
    assert.ok(out.args.includes('--verbose'), '额外参数要带上');
    assert.equal(out.args.filter((a) => a === '--port').length, 1, '端口只出现一次');
    assert.ok(out.args.includes('--voices-dir') === false, '没有 voices 目录就不传这个参数');
    assert.match(out.logFile, /breeze-service\.log$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveLaunch 会去掉用户自己写的 host/port，免得服务收到两遍', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-launch2-'));
  try {
    const exe = join(dir, 'breeze-server.exe');
    const model = join(dir, 'x.gguf');
    writeFileSync(exe, '');
    writeFileSync(model, '');
    const out = resolveLaunch({
      localServiceExe: exe, localServiceModel: model,
      localServiceArgs: '--host 0.0.0.0 --port 1234 --chunk-max 30',
    }, { dataDir: dir });
    assert.ok(out.ok);
    assert.equal(out.args.filter((a) => a === '--host').length, 1);
    assert.equal(out.args[out.args.indexOf('--host') + 1], '127.0.0.1');
    assert.deepEqual(out.args.slice(out.args.indexOf('--chunk-max'), out.args.indexOf('--chunk-max') + 2), ['--chunk-max', '30']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveLaunch 没配 exe 时说清楚怎么办', () => {
  const out = resolveLaunch({}, {});
  assert.equal(out.ok, false);
  assert.match(out.error, /breeze-server\.exe/);
});

test('已经在跑就不再起一个', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-svc1-'));
  try {
    let spawned = 0;
    const svc = createLocalService({
      getConfig: () => ({ localBaseUrl: 'http://127.0.0.1:8137' }),
      dataDir: dir,
      spawnFn: () => { spawned += 1; return fakeProcess(); },
      fetchFn: fakeFetch({ failTimes: 0 }),
    });
    const r = await svc.start();
    assert.equal(r.ok, true);
    assert.equal(r.already, true);
    assert.equal(spawned, 0);
    const st = await svc.status();
    assert.equal(st.running, true);
    assert.equal(st.pid, null, '不是自己起的，就没有 pid 可停');
    assert.equal(st.managed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('起服务：等 /health 就绪后才算成功，并记下 pid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-svc2-'));
  try {
    const exe = join(dir, 'breeze-server.exe');
    const model = join(dir, 'x.gguf');
    writeFileSync(exe, '');
    writeFileSync(model, '');
    const proc = fakeProcess(777);
    let started;

    const svc = createLocalService({
      getConfig: () => ({ localServiceExe: exe, localServiceModel: model, localServiceArgs: '' }),
      dataDir: dir,
      spawnFn: (file, args, opts) => { started = { file, args, opts }; return proc; },
      // 第一次探测还不行，第二次才行：验证它真的在等
      fetchFn: fakeFetch({ failTimes: 1 }),
    });
    const r = await svc.start({ waitMs: 5000 });
    assert.equal(r.ok, true);
    assert.equal(r.pid, 777);
    assert.equal(started.file, exe);
    assert.equal(started.opts.windowsHide, true, '不能弹控制台');
    assert.deepEqual(started.opts.stdio, ['ignore', 'pipe', 'pipe']);
    const state = JSON.parse(readFileSync(join(dir, 'local-service.json'), 'utf8'));
    assert.equal(state.pid, 777);
    assert.equal(state.exe, exe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('进程启动后就退出：立刻报错，不干等到超时', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-svc3-'));
  try {
    const exe = join(dir, 'breeze-server.exe');
    const model = join(dir, 'x.gguf');
    writeFileSync(exe, '');
    writeFileSync(model, '');
    const proc = fakeProcess(778);
    const svc = createLocalService({
      getConfig: () => ({ localServiceExe: exe, localServiceModel: model }),
      dataDir: dir,
      spawnFn: () => {
        setTimeout(() => proc.emit('exit', 1, null), 30);
        return proc;
      },
      fetchFn: fakeFetch({ failTimes: 99 }),
    });
    const began = Date.now();
    const r = await svc.start({ waitMs: 8000 });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - began < 3000, `不该等满 8 秒（实际 ${Date.now() - began}ms）`);
    assert.match(r.error, /退出/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('停服务：只动自己起的那个，停完端口不再响应', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-svc4-'));
  try {
    const exe = join(dir, 'breeze-server.exe');
    const model = join(dir, 'x.gguf');
    writeFileSync(exe, '');
    writeFileSync(model, '');
    const proc = fakeProcess(process.pid);   // 用一个真的活着的 pid，让 isAlive 说"在"
    const killed = [];
    let up = false;                          // 服务一开始没起，spawn 之后才算起来
    const fetchFn = async () => {
      if (!up) throw new Error('connect ECONNREFUSED');
      return { ok: true, json: async () => ({ status: 'ok', sample_rate: 24000 }) };
    };
    const svc = createLocalService({
      getConfig: () => ({ localServiceExe: exe, localServiceModel: model }),
      dataDir: dir,
      spawnFn: (file, args) => {
        if (file === 'taskkill') {
          killed.push(args);
          up = false;
          const k = new EventEmitter();
          setTimeout(() => k.emit('exit', 0), 5);
          return k;
        }
        up = true;
        return proc;
      },
      fetchFn,
    });
    const started = await svc.start({ waitMs: 3000 });
    assert.equal(started.ok, true);
    const stopped = await svc.stop();
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.deepEqual(killed[0], ['/PID', String(process.pid), '/T', '/F']);
    assert.throws(
      () => readFileSync(join(dir, 'local-service.json'), 'utf8'),
      /ENOENT/,
      '状态文件要清掉，免得下次挂载去认领一个已经不存在的进程',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('进程起不来（error 事件）：立刻失败，不干等', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-svc7-'));
  try {
    const exe = join(dir, 'breeze-server.exe');
    const model = join(dir, 'x.gguf');
    writeFileSync(exe, '');
    writeFileSync(model, '');
    const proc = fakeProcess(779);
    const svc = createLocalService({
      getConfig: () => ({ localServiceExe: exe, localServiceModel: model }),
      dataDir: dir,
      spawnFn: () => {
        setTimeout(() => proc.emit('error', new Error('spawn EACCES')), 20);
        return proc;
      },
      fetchFn: fakeFetch({ failTimes: 99 }),
    });
    const began = Date.now();
    const r = await svc.start({ waitMs: 8000 });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - began < 3000, `不该等满 8 秒（实际 ${Date.now() - began}ms）`);
    assert.match(r.error, /EACCES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没在跑的时候按停止：说清楚，不假装成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-svc5-'));
  try {
    const svc = createLocalService({
      getConfig: () => ({ localBaseUrl: 'http://127.0.0.1:9' }),
      dataDir: dir,
      fetchFn: async () => { throw new Error('offline'); },
      spawnFn: () => fakeProcess(),
    });
    const r = await svc.stop();
    assert.equal(r.ok, false);
    assert.match(r.error, /没有在运行/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('日志尾巴：读最后几行，文件不在就是空串', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-svc6-'));
  try {
    const svc = createLocalService({ getConfig: () => ({}), dataDir: dir, fetchFn: async () => { throw new Error('x'); } });
    assert.equal(svc.logTail(20), '');
    writeFileSync(join(dir, 'breeze-service.log'), 'a\nb\nc\n');
    assert.equal(svc.logTail(2).trim(), 'b\nc');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isAlive 认得活进程与不存在的 pid', async () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(999999), false);
  await sleep(1);
});

test('World 卸载后宽限期到点才停服务（关 Coopanion 时不留孤儿）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-svc8-'));
  try {
    const exe = join(dir, 'breeze-server.exe');
    const model = join(dir, 'x.gguf');
    writeFileSync(exe, '');
    writeFileSync(model, '');
    const proc = fakeProcess(process.pid);   // 真活着的 pid，isAlive 才说"在"
    const killed = [];
    let up = false;
    const svc = createLocalService({
      getConfig: () => ({ localServiceExe: exe, localServiceModel: model }),
      dataDir: dir,
      graceMs: 60,
      spawnFn: (file, args) => {
        if (file === 'taskkill') {
          killed.push(args);
          up = false;
          const k = new EventEmitter();
          setTimeout(() => k.emit('exit', 0), 5);
          return k;
        }
        up = true;
        return proc;
      },
      fetchFn: async () => {
        if (!up) throw new Error('connect ECONNREFUSED');
        return { ok: true, json: async () => ({ status: 'ok', sample_rate: 24000 }) };
      },
    });
    assert.equal((await svc.start({ waitMs: 3000 })).ok, true);

    svc.dispose();
    assert.equal(killed.length, 0, 'dispose 不该立刻杀——World 重启走的是同一条路');
    await sleep(160);
    assert.equal(killed.length, 1, '宽限期过了就要停');
    assert.deepEqual(killed[0], ['/PID', String(process.pid), '/T', '/F']);
    assert.throws(() => readFileSync(join(dir, 'local-service.json'), 'utf8'), /ENOENT/,
      '停掉之后状态文件要清掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('World 重启（宽限期内 start）撤销停止，模型不用重载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-svc9-'));
  try {
    const exe = join(dir, 'breeze-server.exe');
    const model = join(dir, 'x.gguf');
    writeFileSync(exe, '');
    writeFileSync(model, '');
    const proc = fakeProcess(process.pid);
    const killed = [];
    let up = false;
    const mk = () => createLocalService({
      getConfig: () => ({ localServiceExe: exe, localServiceModel: model }),
      dataDir: dir,
      graceMs: 120,
      spawnFn: (file, args) => {
        if (file === 'taskkill') {
          killed.push(args);
          up = false;
          const k = new EventEmitter();
          setTimeout(() => k.emit('exit', 0), 5);
          return k;
        }
        up = true;
        return proc;
      },
      fetchFn: async () => {
        if (!up) throw new Error('connect ECONNREFUSED');
        return { ok: true, json: async () => ({ status: 'ok', sample_rate: 24000 }) };
      },
    });

    const first = mk();
    assert.equal((await first.start({ waitMs: 3000 })).ok, true);
    first.dispose();                       // World 卸载
    const second = mk();                   // 框架马上又挂载回来（新实例）
    const again = await second.start({ waitMs: 3000 });
    assert.equal(again.ok, true);
    assert.equal(again.already, true, '服务还在跑，直接认领，不该重起');
    await sleep(200);
    assert.deepEqual(killed, [], 'World 重启不能把服务带走');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态文件里的 pid 已经被别的程序复用：不认领、清文件、不乱杀', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbt-svc10-'));
  try {
    // 拿一个真的活着的 pid（自己的 node），但 exe 写成一个不存在于进程表的程序名
    writeFileSync(join(dir, 'local-service.json'), JSON.stringify({
      pid: process.pid, startedAt: Date.now(), exe: 'C:/somewhere/breeze-server.exe',
    }));
    const killed = [];
    const svc = createLocalService({
      getConfig: () => ({ localBaseUrl: 'http://127.0.0.1:9' }),
      dataDir: dir,
      spawnFn: (file, args) => {
        if (file === 'taskkill') killed.push(args);
        const k = new EventEmitter();
        setTimeout(() => k.emit('exit', 0), 5);
        return k;
      },
      fetchFn: async () => { throw new Error('offline'); },
    });
    const st = await svc.status();
    assert.equal(st.managed, false, '进程名对不上就不能当作自己的服务');
    assert.equal(st.pid, null);
    assert.throws(() => readFileSync(join(dir, 'local-service.json'), 'utf8'), /ENOENT/,
      '过期的状态文件要清掉，免得下次又认错');
    assert.deepEqual(killed, [], '更不能用 taskkill 去动那个无关进程');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
