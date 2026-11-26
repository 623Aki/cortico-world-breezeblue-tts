/**
 * 本机 breeze-tts-2 服务的进程管家。
 *
 * 为什么要它：以前这个服务得靠 `start-breeze.bat` 手动开——一个黑窗口一直挂着，模型没加载
 * 完也不知道，忘了开就整段朗读全走系统语音。这里把「起、停、等就绪、看日志」都收进扩展：
 *
 *   - 启动用 `breeze-server.exe <模型> --host … --port … --webui`，`windowsHide` 让控制台不出现；
 *     `--webui` 只是让它顺带把自带网页挂在 `/`，**不会**自动开浏览器；
 *   - 就绪不看 stdout（它在管道里是 4 KB 块缓冲，什么也看不到），而是轮询 `GET /health`；
 *   - 端口从 `localBaseUrl` 里解析，所以配置里改地址，起服务也跟着改端口；
 *   - 只有自己起的进程才记进 `<数据目录>/local-service.json`，重启 World 后靠它认领；
 *     手动开的服务只报告「在跑」，不去抢着关它。
 *
 * 关掉 Coopanion 时服务要跟着走（模型常驻几百 MB 内存 + 显存，还没窗口，很容易忘），
 * 但重启 World 时不能走——那会把加载好的模型重载一遍。两者的 `stop()` 长得一模一样，
 * 区别只有「之后还会不会有 start()」。所以 `dispose()` 不立刻杀，先挂一个 STOP_GRACE_MS
 * 的定时器，`start()` 一来就撤销；Coopanion 真退出时定时器照常触发。
 * 退出太快（定时器还没到点进程就没了）再用 `process.on('exit')` 里的同步 taskkill 兜底。
 *
 * 失败一律返回 `{ ok: false, error }`，不抛异常：服务起不来只是没有本机语音，朗读要照常能退回落。
 */
import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { localBaseUrl } from './local.js';
import { clampInt } from './config.js';

/** 模型加载 + 预热通常十几秒；给足两分钟，慢机器也不会被误判成失败。 */
const START_WAIT_MS = 120_000;
/** 轮询 /health 的间隔：模型就绪后能在半秒内被看见。 */
const POLL_MS = 400;
/** 日志超过这个大小就先转成 .old，免得一个进程写几个月把盘占满。 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;
/** `/health` 只是存活探测，800ms 没回就是没起。 */
const HEALTH_TIMEOUT_MS = 800;
/**
 * World 停掉之后，等这么久再杀服务。
 *
 * 重启 World 是先 stop() 再 start()，间隔通常几十毫秒；等 2.5 秒足够区分「重启」
 * 和「Coopanion 要退了」。Coopanion 的关机流程（core → llm → flush → web）一般要
 * 一两秒，所以这个定时器来得及跑；万一它跑赢了我们，还有 `process.on('exit')` 兜底。
 */
const STOP_GRACE_MS = 2_500;

/**
 * 关掉 host-visible 显存分配：开了 ReBAR 的机器上 ggml Vulkan 会把约 1 GB 工作缓冲
 * 放进共享内存，逐帧跨 PCIe 读写使合成慢一个数量级（RTF 0.19x → 2.1x）。
 * 只传给服务进程，不改 Coopanion 自身或调用方的环境。
 */
const SERVICE_ENV = { ...process.env, GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM: '1' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 本进程起的服务：pid → exe。
 *
 * 模块级而不是实例级，因为 World 重启会换一个实例，但进程还是同一个（靠状态文件认领）。
 * `process.on('exit')` 里按这个表做最后的同步清理。
 */
const owned = new Map();
let exitHookArmed = false;

/** 查这个 pid 现在是什么程序（同步，exit 钩子里只能用同步 API）。 */
function processNameSync(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    if (process.platform === 'win32') {
      // /NH 去掉表头，/FO CSV 一列一个引号，第一列就是映像名
      const r = spawnSync('tasklist', ['/FI', `PID eq ${n}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true, encoding: 'utf8', timeout: 3000,
      });
      const line = String(r?.stdout || '').split('\n')[0]?.trim() || '';
      const m = line.match(/^"([^"]+)"/);
      return m ? m[1] : '';
    }
    const r = spawnSync('ps', ['-p', String(n), '-o', 'comm='], { encoding: 'utf8', timeout: 3000 });
    return String(r?.stdout || '').split('\n')[0]?.trim() || '';
  } catch {
    return '';
  }
}

/**
 * 这个 pid 还是不是我们起的那个程序。
 *
 * 只看 `isAlive` 不够：Windows 会复用 pid，状态文件里那个号可能已经属于别的程序，
 * 认领错了再按「停止」就会 taskkill 掉无关进程。所以拿进程名对一下，
 * 名对不上（或查不到）就不认。
 */
export function isOurProcess(pid, exe) {
  const want = String(exe || '').split(/[\\/]/).pop().toLowerCase();
  if (!want) return isAlive(pid);        // 不知道 exe 时只能看存活
  const got = processNameSync(pid).toLowerCase();
  if (!got) return false;                // 查不到＝不是它（或已经没了）
  return got === want;
}

/** 同步杀掉一棵进程树（只在退出钩子里用）。 */
function killSync(pid, exe) {
  const n = Number(pid);
  if (!n) return;
  // 复用校验：宁可留个孤儿，也不要把别人的进程杀掉
  if (exe && !isOurProcess(n, exe)) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } else {
      process.kill(n, 'SIGKILL');
    }
  } catch { /* 已经没了 */ }
}

/** 退出时兜底：正常退出与强杀之外的路径都走这里。 */
function armExitHook() {
  if (exitHookArmed) return;
  exitHookArmed = true;
  // exit 回调里只能用同步调用，Promise 不会被等
  process.on('exit', () => {
    for (const [pid, exe] of owned) killSync(pid, exe);
    owned.clear();
  });
}

/**
 * 待执行的延迟停止。
 *
 * 必须是模块级：World 重启时框架会新 `create()` 一个实例，实例上的定时器新实例取消不了，
 * 于是「重启 World」和「关 Coopanion」就分不开了。同一时刻只有一台本机服务，所以单槽够用。
 */
let pending = null;   // { pid, timer }


/** 把 base 地址拆成 host / port；解析不出端口就用服务的缺省 8137。 */
export function splitBaseUrl(base) {
  const raw = String(base ?? '').trim() || 'http://127.0.0.1:8137';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    return { host: url.hostname || '127.0.0.1', port };
  } catch {
    return { host: '127.0.0.1', port: 8137 };
  }
}

/** 拆命令行参数：认单双引号，不认管道与变量展开（本机自用足够）。 */
export function splitArgs(text) {
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const ch of String(text ?? '')) {
    if (quote) {
      if (ch === quote) quote = '';
      else { cur += ch; has = true; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** 引号包一下空路径，Windows 的命令行解析靠它。 */
function quoteWin(value) {
  const s = String(value ?? '');
  if (s && !/\s/.test(s) && !/"/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** 只看目录里有没有这些后缀的文件（自动找模型用）。 */
function firstFileIn(dir, extensions) {
  try {
    const hit = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && extensions.some((ext) => e.name.toLowerCase().endsWith(ext)))
      .map((e) => join(dir, e.name))
      .sort((a, b) => basename(a).localeCompare(basename(b)))[0];
    return hit ?? '';
  } catch {
    return '';
  }
}

/**
 * 从配置里算出「怎么起这个服务」。
 *
 * 路径来源优先级：配置项 → 上一次成功用过的（状态文件）→ 环境变量 BREEZE_SERVER_EXE。
 * 模型没填就在 exe 的同级与上一级目录里找 `.gguf`（发行包把 exe 放子目录、模型放根目录）。
 * 找不到不抛错：返回 error 让面板说清楚要填哪一项。
 */
export function resolveLaunch(cfg = {}, { dataDir = '', lastUsed = null } = {}) {
  const base = localBaseUrl(cfg);
  const { host, port } = splitBaseUrl(base);
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

  const exe = pick(cfg.localServiceExe)
    || pick(lastUsed?.exe)
    || pick(process.env.BREEZE_SERVER_EXE);
  if (!exe) {
    return {
      ok: false, base, host, port,
      error: '没配置 breeze-server.exe 的路径：请在「本地服务进程」里选中它（发行包里叫 breeze-server.exe），或设置环境变量 BREEZE_SERVER_EXE',
    };
  }
  if (!existsSync(exe)) {
    return { ok: false, base, host, port, exe, error: `找不到这个文件：${exe}` };
  }

  const exeDir = dirname(resolve(exe));
  let model = pick(cfg.localServiceModel) || pick(lastUsed?.model);
  if (!model) model = firstFileIn(exeDir, ['.gguf']) || firstFileIn(resolve(exeDir, '..'), ['.gguf']);
  if (!model) {
    return { ok: false, base, host, port, exe, error: '没找到模型文件（.gguf）：请在「本地服务进程」里选中它' };
  }
  if (!existsSync(model)) {
    return { ok: false, base, host, port, exe, model, error: `找不到模型文件：${model}` };
  }

  // 音色目录：配置了就用，否则找模型旁边的 voices/（发行包的摆法）
  let voicesDir = pick(cfg.localServiceVoicesDir);
  if (!voicesDir) {
    const guess = join(dirname(resolve(model)), 'voices');
    voicesDir = existsSync(guess) ? guess : '';
  } else if (!existsSync(voicesDir)) {
    voicesDir = '';
  }

  const extra = splitArgs(cfg.localServiceArgs ?? '--chunk-max 40');
  // 这几个由扩展自己算，用户参数里重复写就以扩展的为准（写两遍服务会报错）
  const owned = new Set(['--host', '--port', '--voices-dir']);
  const args = [model, '--host', host, '--port', String(port), '--webui'];
  for (let i = 0; i < extra.length; i += 1) {
    if (owned.has(extra[i])) { i += 1; continue; }
    args.push(extra[i]);
  }
  if (voicesDir) args.push('--voices-dir', voicesDir);

  const logFile = join(dataDir || exeDir, 'breeze-service.log');
  return { ok: true, base, host, port, exe, exeDir, model, voicesDir, args, logFile, cwd: exeDir };
}

/** 服务的 /health：800ms 内没回就当没起，别让面板等。 */
export async function probeHealth(base, { timeoutMs = HEALTH_TIMEOUT_MS, fetchFn = fetch } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${base}/health`, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) return { ok: false, error: `健康检查返回 ${res.status}`, ms: Date.now() - started };
    const info = await res.json().catch(() => ({}));
    return {
      ok: true,
      ms: Date.now() - started,
      sampleRate: Number(info?.sample_rate) || null,
      wsPort: Number(info?.ws_port) || null,
    };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: controller.signal.aborted ? `健康检查超时（${timeoutMs}ms）` : `连不上 ${base}：${err?.message ?? err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 进程还在不在（Windows 上 signal 0 只做存在性检查）。 */
export function isAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 起一个服务管家。
 *
 * @param getConfig 现取配置（改了端口下一次启动就生效）
 * @param dataDir   部署目录：状态文件与日志都放这里
 * @param log       (level, message) 写运行日志
 * @param graceMs   停之后等多久才真杀（测试调小，免得每条用例等 2.5 秒）
 * @param spawnFn / fetchFn / existsFn 测试注入
 */
export function createLocalService({ getConfig = () => ({}), dataDir = '', log = () => {}, graceMs = STOP_GRACE_MS, spawnFn = spawnProcess, fetchFn = fetch } = {}) {
  let child = null;
  let stream = null;
  let startedAt = 0;
  let phase = 'stopped';       // stopped | starting | running | error
  let lastError = '';
  let lastStartMs = 0;
  let stopping = false;
  /** 状态文件的 pid 是不是真属于我们的 exe：查过一次就记住，别每次 status 都起 tasklist。 */
  let verifyCache = { key: '', ok: false };

  const stateFile = () => (dataDir ? join(dataDir, 'local-service.json') : '');

  function readState() {
    const file = stateFile();
    if (!file) return null;
    try {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      return json && typeof json === 'object' ? json : null;
    } catch {
      return null;
    }
  }

  function writeState(state) {
    const file = stateFile();
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (state) writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
      else if (existsSync(file)) unlinkSync(file);
    } catch { /* 状态文件写不了只影响"重启后认领"，不影响起停 */ }
  }

  /**
   * 安排一次「过一会儿就停」，用于 World 卸载：重启 World 会在宽限期内 start() 回来，
   * 那时撤销即可；Coopanion 真退出时定时器到点照杀。
   */
  function scheduleStop(pid, exe) {
    cancelScheduledStop();
    if (!pid) return;
    owned.set(pid, exe || owned.get(pid) || '');
    armExitHook();
    const timer = setTimeout(() => {
      if (pending?.timer !== timer) return;      // 已经被 start() 撤销
      pending = null;
      if (!isAlive(pid)) { owned.delete(pid); writeState(null); return; }
      void killTree(pid).then((r) => {
        owned.delete(pid);
        writeState(null);
        // 三种情况都走这里：关 Coopanion、停用 World、卸载扩展。文案不能说成「退出」。
        if (r.ok) log('info', 'World 已卸载且没有回来：本机语音服务已停止');
        else log('warn', `停止本机语音服务失败：${r.error ?? '未知原因'}`);
      });
    }, Math.max(1, graceMs));
    // 别让这个定时器拖住 Node 退出——真到那一步还有 exit 钩子
    timer.unref?.();
    pending = { pid, timer };
  }

  function cancelScheduledStop() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  }

  /** 日志先转到 .old 再追加，避免无限长大。 */
  function openLog(file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      try { if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.old`); } catch { /* 还没日志 */ }
      const stream = createWriteStream(file, { flags: 'a' });
      // 写流是异步打开的：目录被删、盘满、句柄失效都在 'error' 里报，
      // 没人接就是 uncaughtException，会带走整个 Coopanion。日志写不了不值得这样。
      stream.on('error', () => {});
      return stream;
    } catch {
      return null;
    }
  }

  function attachOutput(proc, out) {
    const sink = (buf) => {
      const text = String(buf);
      try { out?.write(text); } catch { /* 盘满或句柄没了 */ }
      if (process.env.PET_VOICE_SERVICE_ECHO === '1') process.stderr.write(`[breeze] ${text}`);
    };
    proc.stdout?.on('data', sink);
    proc.stderr?.on('data', sink);
  }

  /**
   * 状态文件里那个 pid 还算不算我们的。
   *
   * 只看存活会被 pid 复用骗过去：系统把号给了别的程序，我们认领回来，用户一按「停止」
   * 就 taskkill 掉无关进程。所以核对进程名，结果按 pid 缓存（省掉重复的 tasklist）。
   */
  function savedAlive(saved) {
    const pid = Number(saved?.pid) || 0;
    if (!pid || !isAlive(pid)) return 0;
    const key = `${pid}|${saved?.exe ?? ''}`;
    if (verifyCache.key !== key) verifyCache = { key, ok: isOurProcess(pid, saved?.exe) };
    return verifyCache.ok ? pid : 0;
  }

  /** 状态：先看自己起的进程，再看状态文件，最后看服务本身回不回话。 */
  async function status() {
    const cfg = getConfig() || {};
    const base = localBaseUrl(cfg);
    const saved = readState();
    const health = await probeHealth(base, { fetchFn });
    const ownPid = child?.pid ?? 0;
    const adopted = savedAlive(saved);
    // 状态文件写着、但那个号已经是别人的进程：文件过期了，清掉免得下次又认错
    if (saved && !adopted && Number(saved.pid) !== ownPid) writeState(null);
    const pid = ownPid && isAlive(ownPid) ? ownPid : adopted;
    const since = startedAt || Number(saved?.startedAt) || 0;
    return {
      base,
      running: health.ok,
      health,
      pid: pid || null,
      managed: Boolean(pid),          // 这个扩展起的（能停）
      startedAt: since,
      uptimeMs: since ? Date.now() - since : 0,
      phase: health.ok ? (phase === 'starting' ? 'starting' : 'running') : (phase === 'starting' ? 'starting' : phase === 'error' ? 'error' : 'stopped'),
      startMs: lastStartMs,
      error: health.ok ? '' : lastError || health.error || '',
      logFile: stateFile() ? join(dataDir, 'breeze-service.log') : '',
    };
  }

  /** 起服务并等它就绪。已经在跑就只回报状态。 */
  async function start({ waitMs = START_WAIT_MS } = {}) {
    // 上一轮 dispose 安排的停止作废：这是 World 重启，不是 Coopanion 退出
    cancelScheduledStop();
    const cfg = getConfig() || {};
    const base = localBaseUrl(cfg);
    const running = await probeHealth(base, { fetchFn });
    if (running.ok) {
      phase = 'running';
      return { ok: true, already: true, base, health: running, message: '服务已经在运行' };
    }
    if (phase === 'starting') return { ok: false, busy: true, error: '正在启动中，请稍候' };

    const launch = resolveLaunch(cfg, { dataDir, lastUsed: readState() });
    if (!launch.ok) {
      phase = 'error';
      lastError = launch.error;
      log('warn', `本机语音服务没起来：${launch.error}`);
      return { ok: false, error: launch.error, base };
    }

    phase = 'starting';
    lastError = '';
    stopping = false;
    const started = Date.now();
    const out = openLog(launch.logFile);
    stream = out;
    try {
      out?.write(`\n=== ${new Date().toISOString()} 启动 ${launch.exe}\n`);
      out?.write(`    参数：${launch.args.join(' ')}\n`);
    } catch { /* 日志写不了也照起 */ }

    let proc;
    try {
      const isScript = /\.(bat|cmd)$/i.test(launch.exe);
      proc = isScript
        ? spawnFn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [launch.exe, ...launch.args].map(quoteWin).join(' ')], {
          cwd: launch.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: SERVICE_ENV,
        })
        : spawnFn(launch.exe, launch.args, {
          cwd: launch.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: SERVICE_ENV,
        });
    } catch (err) {
      phase = 'error';
      lastError = `起不来：${err?.message ?? err}`;
      log('warn', `本机语音服务${lastError}`);
      try { out?.end(); } catch { /* ignore */ }
      return { ok: false, error: lastError, base };
    }

    child = proc;
    startedAt = started;
    owned.set(proc.pid, launch.exe);
    armExitHook();
    writeState({ pid: proc.pid, startedAt: started, exe: launch.exe, model: launch.model });
    attachOutput(proc, out);
    log('info', `本机语音服务启动中：${basename(launch.exe)} ${launch.host}:${launch.port}（pid ${proc.pid}）`);

    let exited = 0;
    proc.on('error', (err) => {
      // 连进程都没起来（exe 不对、权限不够）：别在这儿干等两分钟
      lastError = `进程出错：${err?.message ?? err}`;
      phase = 'error';
      exited = -1;
    });
    proc.on('exit', (code, signal) => {
      exited = code ?? -1;
      const wasRunning = phase === 'running';
      phase = stopping ? 'stopped' : 'error';
      if (!stopping) lastError = `服务进程退出了（code ${exited}${signal ? `, ${signal}` : ''}）`;
      if (child === proc) child = null;
      owned.delete(proc.pid);
      writeState(null);
      if (!stopping) log('warn', `本机语音服务退出（code ${exited}），日志：${launch.logFile}`);
      else if (wasRunning) log('info', '本机语音服务已停止');
      try { out?.end(); } catch { /* ignore */ }
      stream = null;
    });

    const deadline = started + waitMs;
    while (Date.now() < deadline) {
      if (exited) break;
      const health = await probeHealth(base, { fetchFn });
      if (health.ok) {
        phase = 'running';
        lastStartMs = Date.now() - started;
        log('info', `本机语音服务就绪：${base}（${health.sampleRate ?? '?'} Hz，用时 ${(lastStartMs / 1000).toFixed(1)}s）`);
        return { ok: true, base, pid: proc.pid, health, ms: lastStartMs };
      }
      await sleep(POLL_MS);
    }

    const ms = Date.now() - started;
    phase = 'error';
    lastError = exited === -1
      // 进程压根没起来：错误已经写在 lastError 里，别覆盖成 "code -1"
      ? `${lastError}；日志：${launch.logFile}`
      : (exited
        ? `服务进程启动后就退出了（code ${exited}）；日志：${launch.logFile}`
        : `${Math.round(waitMs / 1000)} 秒内没等到 ${base}/health 就绪；日志：${launch.logFile}`);
    log('warn', lastError);
    try { proc.kill(); } catch { /* 已经没了 */ }
    return { ok: false, error: lastError, base, ms };
  }

  /** 停掉自己起的那个（含子进程）。别处手动开的服务不动。 */
  async function stop() {
    // 面板上按「停止」是立刻要停，不走宽限
    cancelScheduledStop();
    const cfg = getConfig() || {};
    const base = localBaseUrl(cfg);
    const saved = readState();
    const pid = child?.pid ?? savedAlive(saved);
    if (!pid) {
      const health = await probeHealth(base, { fetchFn });
      return {
        ok: false,
        error: health.ok ? '这个服务不是本扩展启动的；要关请在它自己的窗口或任务管理器里关' : '服务没有在运行',
      };
    }
    stopping = true;
    phase = 'stopped';
    const killed = await killTree(pid);
    child = null;
    startedAt = 0;
    owned.delete(pid);
    writeState(null);
    try { stream?.end(); } catch { /* ignore */ }
    stream = null;
    // 端口真的放开才算停掉：进程退出和 socket 释放中间有一小段
    for (let i = 0; i < 15; i += 1) {
      const health = await probeHealth(base, { fetchFn });
      if (!health.ok) {
        log('info', '本机语音服务已停止');
        return { ok: killed.ok !== false, base, stopped: true };
      }
      await sleep(200);
    }
    return { ok: false, error: '已发出停止命令，但端口仍在响应' };
  }

  /** 停进程树：breeze-server 没有优雅退出的信号处理，Windows 上用 taskkill /T /F。 */
  function killTree(pid) {
    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGTERM'); return Promise.resolve({ ok: true }); } catch (err) { return Promise.resolve({ ok: false, error: String(err?.message ?? err) }); }
    }
    return new Promise((resolveKill) => {
      let done = false;
      let timer = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolveKill(result);
      };
      try {
        const killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', (err) => finish({ ok: false, error: err?.message ?? String(err) }));
        killer.on('exit', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: `taskkill 退出码 ${code}` }));
      } catch (err) {
        finish({ ok: false, error: err?.message ?? String(err) });
      }
      // 兜底超时；unref 掉，别让这个定时器把 Coopanion 的退出拖住 8 秒
      timer = setTimeout(() => finish({ ok: true, timeout: true }), 8000);
      timer.unref?.();
    });
  }

  /** 日志尾巴，面板的「查看日志」用。 */
  function logTail(lines = 60) {
    const file = dataDir ? join(dataDir, 'breeze-service.log') : '';
    if (!file) return '';
    try {
      const text = readFileSync(file, 'utf8');
      const all = text.trimEnd().split('\n');
      return all.slice(Math.max(0, all.length - clampInt(lines, 1, 400, 80))).join('\n');
    } catch {
      return '';
    }
  }

  return {
    status,
    start,
    stop,
    logTail,
    resolveLaunch: () => resolveLaunch(getConfig() || {}, { dataDir, lastUsed: readState() }),
    /**
     * World 卸载：放掉句柄，并**安排**一次停止。
     *
     * 不立刻杀，是因为 World 重启也走这里：宽限期内 start() 会回来，撤销即可，
     * 模型不用重载。Coopanion 真退出时没有 start() 会来，定时器到点就把它停掉；
     * 退出太快则由 `process.on('exit')` 同步兜底。
     *
     * 认领回来的进程（child 为 null、pid 记在状态文件里）同样算在内——重启 World 后
     * 再关 Coopanion，它也得跟着走。
     */
    dispose() {
      try { stream?.end(); } catch { /* ignore */ }
      stream = null;
      const saved = readState();
      const pid = child?.pid ?? savedAlive(saved);
      const exe = saved?.exe ?? '';
      child = null;
      if (!pid) return;
      scheduleStop(pid, exe);
      log('info', `World 已卸载；${(graceMs / 1000).toFixed(1)} 秒内没有重启就停掉本机语音服务`);
    },
  };
}
