/**
 * 本机服务的音色库 → 配置页的下拉选项。
 *
 * 为什么要在中间垫一层缓存：框架的 `/api/config/options/:kind` 是**同步**取值的
 * （src/web/server.ts 里直接 `src.options?.(kind)`），而音色表得问
 * `GET <base>/v1/voices`。所以这里把结果记在内存里，同时落一份到部署目录的
 * voice-library.json，下次开配置页不用等网络就有选项；真正刷新的动作是后台
 * fire-and-forget，刷新失败只保留上一份，不抛错、不挡面板。
 *
 * 服务没起来时也要能给出选项（至少给「留空＝现场设计」这一条），否则下拉是空的，
 * 用户会以为配置坏了。
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localBaseUrl, listLocalVoices, LOCAL_DEFAULT_BASE_URL } from './local.js';
import { resolveDataDir } from './events.js';

/** 缓存文件名：放在 World 的数据目录（ctx.dataDir）里，不往程序目录写。 */
const CACHE_FILE = 'voice-library.json';

/** 两次自动刷新之间至少隔这么久，避免面板每探一次就打一次服务。 */
const MIN_REFRESH_MS = 15_000;

/** 读音色表的超时；本机服务很快，慢就是没起。 */
const REFRESH_TIMEOUT_MS = 3000;

/** base → { at, voices, error } */
const cache = new Map();

/** base → 上次真去请求的时间（失败也记，避免服务没起时被反复打）。 */
const attempts = new Map();

let diskDir = '';
let diskLoaded = false;
let inflight = null;
/** 实例手里的活配置对象：端口一改，这里立刻能看到（框架是深合并进同一个对象）。 */
let liveCfg = null;

/** 把 id 之外的信息压成一行说明，放进下拉标签里。 */
function shortDescription(voice) {
  const raw = typeof voice?.description === 'string' ? voice.description.trim() : '';
  if (!raw) {
    const persona = typeof voice?.metadata?.persona === 'string' ? voice.metadata.persona.trim() : '';
    return persona;
  }
  // 服务的描述习惯写成「名字：解释」，取冒号/句号前那一段就够认人了
  const head = raw.split(/[：:。\n]/)[0].trim() || raw;
  return head.length > 30 ? `${head.slice(0, 29)}…` : head;
}

/** 一条音色的下拉标签：id 在前，方便直接抄进 config.json。 */
export function voiceLabel(voice) {
  const parts = [String(voice?.id ?? '')];
  const desc = shortDescription(voice);
  if (desc) parts.push(desc);
  const seconds = Number(voice?.seconds);
  // 参考音长度只作区分用：同一个人的不同录音版本，时长是最快的辨认标志
  if (Number.isFinite(seconds) && seconds > 0) parts.push(`${seconds.toFixed(1)}s`);
  return parts.filter(Boolean).join(' · ');
}

/** 读部署目录里上次存下的音色表（同步、只读一次）。读不到就当没有。 */
function loadDisk() {
  if (diskLoaded || !diskDir) return;
  diskLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(join(diskDir, CACHE_FILE), 'utf8'));
    for (const [base, entry] of Object.entries(parsed ?? {})) {
      const voices = Array.isArray(entry?.voices) ? entry.voices.filter((v) => v && typeof v.id === 'string') : [];
      if (!voices.length) continue;
      cache.set(base, { at: Number(entry?.at) || 0, voices, error: null, ok: true, from: 'disk' });
    }
  } catch { /* 没有缓存文件或内容坏了：按空处理 */ }
}

/** 把内存里的音色表写回部署目录；失败不影响使用。 */
function saveDisk() {
  if (!diskDir) return;
  try {
    const out = {};
    for (const [base, entry] of cache) {
      if (entry?.voices?.length) out[base] = { at: entry.at, voices: entry.voices };
    }
    writeFileSync(join(diskDir, CACHE_FILE), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  } catch { /* 只读部署目录、磁盘满，都不该让配置页挂掉 */ }
}

/** World 构造时调一次：指定缓存目录并把上次的结果读进来。 */
export function prepareVoiceLibrary(dataDir, cfg = null) {
  if (cfg && typeof cfg === 'object') liveCfg = cfg;
  const dir = typeof dataDir === 'string' ? dataDir.trim() : '';
  if (!dir) return;
  if (dir !== diskDir) {
    diskDir = dir;
    diskLoaded = false;
    cache.clear();
    attempts.clear();
  }
  loadDisk();
}

/** 已经有结果的音色（同步）。没有就是空数组。 */
export function cachedVoices(cfg = {}) {
  return cacheEntry(cfg)?.voices ?? [];
}

/** 缓存项本身：voices、是否真读到过（ok）、上次错误。面板要区分"空"和"没读过"。 */
function cacheEntry(cfg = {}) {
  loadDisk();
  return cache.get(localBaseUrl(cfg));
}

/** 探测到音色表时顺手更新缓存，省一次请求。 */
export function rememberVoices(baseOrCfg, voices) {
  const base = typeof baseOrCfg === 'string' ? baseOrCfg.replace(/\/+$/, '') : localBaseUrl(baseOrCfg);
  const list = Array.isArray(voices) ? voices.filter((v) => v && typeof v.id === 'string') : [];
  if (!base || !list.length) return;
  const prev = cache.get(base);
  // 探测只拿到 id 时（老版本服务）别把带描述的那份覆盖掉
  const richer = list.some((v) => typeof v.description === 'string' && v.description);
  if (prev?.voices?.length && !richer && prev.voices.some((v) => v.description)) return;
  cache.set(base, { at: Date.now(), voices: list, error: null, ok: true, from: 'probe' });
  saveDisk();
}

/**
 * 后台刷新音色表。默认尊重 MIN_REFRESH_MS，`force` 可绕过（手动点开下拉时用）。
 * 并发调用共用同一个请求。永远不 reject。
 */
export function refreshVoiceLibrary(cfg = {}, { force = false, timeoutMs = REFRESH_TIMEOUT_MS } = {}) {
  const base = localBaseUrl(cfg);
  const prev = cache.get(base);
  const attemptAt = attempts.get(base) ?? 0;
  if (!force && Date.now() - attemptAt < MIN_REFRESH_MS) return Promise.resolve(prev);
  if (inflight?.base === base) return inflight.promise;
  attempts.set(base, Date.now());

  const promise = (async () => {
    const res = await listLocalVoices(cfg, { timeoutMs });
    if (res.ok) {
      const voices = Array.isArray(res.voices) ? res.voices : [];
      cache.set(base, { at: Date.now(), voices, error: null, ok: true, from: 'live' });
      saveDisk();
      return cache.get(base);
    }
    // 失败保留旧结果，只记下最后一次错在哪（面板上不显示，日志里用得到）
    const kept = cache.get(base);
    const entry = { at: kept?.at ?? 0, voices: kept?.voices ?? [], error: res.error, ok: kept?.ok ?? false };
    cache.set(base, entry);
    return entry;
  })()
    .catch((err) => ({ at: 0, voices: [], error: err?.message ?? String(err) }))
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });

  inflight = { base, promise };
  return promise;
}

/**
 * 配置页「音色 ID」的选项（同步）。
 *
 * 除了缓存里的音色，还给一条空值选项：留空＝让服务按「演绎指令」现场设计一个声音。
 * 同时后台刷一次，这样这一次打开下拉是旧的、下一次就是新的（框架在下拉被点开/
 * 获得焦点时会重新问一遍）。
 */
export function localVoiceOptions(cfg = {}, language = 'zh', { refresh = true } = {}) {
  const en = language === 'en';
  const entry = cacheEntry(cfg);
  const voices = entry?.voices ?? [];
  // 后台刷新：不 await，失败也无所谓
  if (refresh) void refreshVoiceLibrary(cfg).catch(() => {});

  const options = voices.map((v) => ({ value: v.id, label: voiceLabel(v) }));
  const known = new Set(options.map((o) => o.value));
  const current = typeof cfg.localVoice === 'string' ? cfg.localVoice.trim() : '';
  // 配置里存着、但服务这会儿没列出来的音色（比如刚被删掉）也留着，否则选不回去
  if (current && !known.has(current)) {
    options.unshift({ value: current, label: en ? `${current} (not in the library now)` : `${current}（不在当前音色库里）` });
  }
  options.unshift({
    value: '',
    label: voices.length
      ? (en ? '(no voice: design one from the instruction)' : '（不用音色：按演绎指令现场设计）')
      : entry?.ok
        ? (en ? '(the library is empty: design one from the instruction, or save a reference voice first)' : '（音色库是空的：留空＝按演绎指令现场设计，或先在服务里存一段参考音）')
        : (en ? '(voice library not read yet: start the local service, then reopen this list)' : '（还没读到音色库：先启动本地服务，再打开本项）'),
  });
  return options;
}

/** 音色数量，面板徽标用。 */
export function voiceCount(cfg = {}) {
  return cachedVoices(cfg).length;
}

/** 配置段名，与 WORLD_ID 一致；不 import config-schema，免得两个模块互相牵连。 */
const WORLD_SECTION = 'breezeblue-tts';

let sectionHint = { mtime: -1, file: '', section: null };

/**
 * 从部署的 config.json 里摸出这一段的 localBaseUrl / localVoice。
 *
 * 为什么不用 ctx：`WorldDefinition.configOptions(kind, language)` 是**定义**上的静态函数，
 * 框架调它时不给实例，也不给 cfg。这里先看实例构造时留下的数据目录（准），读不到再退回
 * 框架自己的解析（自检、CI 里那层可能猜错，但至少能给出选项）。
 */
function deploymentSection() {
  const dirs = [diskDir, (() => { try { return resolveDataDir(); } catch { return ''; } })()].filter(Boolean);
  for (const dir of dirs) {
    // dataDir 是含 runs/ 的那层（Coopanion 里是 home/<bot>/data），config.json 在它上面
    const candidates = [join(dir, 'config.json'), join(dir, '..', 'config.json'), join(dir, '..', '..', 'config.json')];
    for (const file of candidates) {
      let mtime;
      try { mtime = statSync(file).mtimeMs; } catch { continue; }
      if (sectionHint.mtime === mtime && sectionHint.file === file) return sectionHint.section;
      let section = null;
      try {
        const json = JSON.parse(readFileSync(file, 'utf8'));
        const raw = json?.worlds?.[WORLD_SECTION];
        section = raw && typeof raw === 'object' ? raw : null;
      } catch {
        continue;
      }
      sectionHint = { mtime, file, section };
      return section;
    }
  }
  return null;
}

/** 缓存里最近刷新过的地址（多份时取最新的那份）。 */
function lastCachedBase() {
  let best = null;
  for (const [base, entry] of cache) {
    if (!entry?.voices?.length) continue;
    if (!best || (entry.at ?? 0) > best.at) best = { base, at: entry.at ?? 0 };
  }
  if (best) return best.base;
  return cache.size === 1 ? [...cache.keys()][0] : '';
}

/**
 * 配置页真正调用的那一份选项：不需要实例，自己去找地址。
 * 顺序：实例留下的活配置 → 部署 config.json → 缓存里最近的地址 → 默认端口。
 * 活配置排第一是因为它跟面板同步：用户把端口改掉，下一次打开下拉就按新端口问。
 */
export function localVoiceOptionsFromDeployment(language = 'zh') {
  const live = liveCfg && typeof liveCfg === 'object' ? localBaseUrl(liveCfg) : '';
  const section = deploymentSection();
  const base = live
    || (typeof section?.localBaseUrl === 'string' && section.localBaseUrl.trim())
    || lastCachedBase()
    || LOCAL_DEFAULT_BASE_URL;
  const current = (liveCfg && typeof liveCfg.localVoice === 'string' && liveCfg.localVoice.trim())
    || section?.localVoice;
  return localVoiceOptions({ localBaseUrl: base, localVoice: current }, language);
}
