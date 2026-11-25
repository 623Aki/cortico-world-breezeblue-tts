/**
 * World 页的第一张卡：「朗读设置」。
 *
 * 为什么有它：框架的「配置」页按 JSON Schema 一次把所有组铺开，四十多项一字排开，
 * 想改一项得从头翻到尾；而且那套表单只认字段，放不下按钮。这里重排成折叠卡——
 * 每个大标题一行，默认全部收起，收起时右上角显示这块的当前状态；要改哪块再展开。
 * 顶部还有「测试连接」「启动 / 停止服务」「看日志」，本机服务就不必再开那个 .bat。
 *
 * 这份面板是这个 World 唯一的设置入口：框架的「配置」页签不再出现（World 不交 config），
 * 所以不要指望那里还能改到这些字段。
 *
 * 数据面全走 `ctx.invoke('…')`（World 的 invoke），读用 `state`、写用 `save`：
 * 不直连 /api，不碰 document.body，控件与样式都用宿主给的。
 *
 * 这个文件是**浏览器里直接跑的 ESM**，不经过打包：不要加 import，也不要用 TS 语法。
 */

const TEXT = {
  zh: {
    service: '服务',
    running: '运行中',
    stopped: '未运行',
    starting: '启动中',
    loading: '读取配置…',
    loadFailed: (m) => `读不到配置：${m}`,
    test: '测试连接',
    start: '启动服务',
    stop: '停止服务',
    log: '日志',
    refresh: '刷新',
    saving: '保存中…',
    saved: '已保存',
    saveFailed: (m) => `保存失败：${m}`,
    testOk: (r) => `测试通过：${r.base} · ${r.sampleRate ?? '?'} Hz · ${r.voices ?? 0} 个音色 · 合成 ${r.ms ?? '?'} ms`,
    testCloudOk: (r) => `配置齐全：${r.label ?? ''} ${r.model ?? ''} · 音色 ${r.voice || '未填'}（未发起计费请求）`,
    testFail: (m) => `测试失败：${m}`,
    startingWait: '正在启动服务，模型加载要十几秒…',
    startFailed: (m) => `启动失败：${m}`,
    started: (r) => `服务已就绪${r.ms ? `（${(r.ms / 1000).toFixed(1)} 秒）` : ''}`,
    stopFailed: (m) => `停不下来：${m}`,
    stoppedOk: '服务已停止',
    pick: '选择…',
    refreshVoices: '刷新音色',
    voicesRefreshed: (n) => `音色库已刷新：${n} 个`,
    logTitle: '本机服务日志',
    logEmpty: '（还没有日志）',
    launchTitle: '启动命令',
    launchMissing: '还不能启动',
    on: '开',
    off: '关',
    empty: '（空）',
    managed: '由扩展启动',
    external: '别处启动的',
    uptime: (s) => `已运行 ${s}`,
    hot: '改完立刻生效',
    cold: '改完要重启 World',
    stalePage: '这个页面还是旧版本（配置组刚改过），按 Ctrl+R 刷新后再改',
    summaryMissing: '（还没读到）',
  },
  en: {
    service: 'Service',
    running: 'up',
    stopped: 'down',
    starting: 'starting',
    loading: 'Reading settings…',
    loadFailed: (m) => `Cannot read settings: ${m}`,
    test: 'Test connection',
    start: 'Start service',
    stop: 'Stop service',
    log: 'Log',
    refresh: 'Refresh',
    saving: 'Saving…',
    saved: 'Saved',
    saveFailed: (m) => `Save failed: ${m}`,
    testOk: (r) => `OK: ${r.base} · ${r.sampleRate ?? '?'} Hz · ${r.voices ?? 0} voices · ${r.ms ?? '?'} ms`,
    testCloudOk: (r) => `Config complete: ${r.label ?? ''} ${r.model ?? ''} · voice ${r.voice || 'unset'} (no billed request)`,
    testFail: (m) => `Test failed: ${m}`,
    startingWait: 'Starting the service; loading the model takes a while…',
    startFailed: (m) => `Start failed: ${m}`,
    started: (r) => `Service ready${r.ms ? ` (${(r.ms / 1000).toFixed(1)} s)` : ''}`,
    stopFailed: (m) => `Cannot stop: ${m}`,
    stoppedOk: 'Service stopped',
    pick: 'Choose…',
    refreshVoices: 'Refresh voices',
    voicesRefreshed: (n) => `Voice library refreshed: ${n}`,
    logTitle: 'Local service log',
    logEmpty: '(no log yet)',
    launchTitle: 'Command',
    launchMissing: 'Not startable yet',
    on: 'on',
    off: 'off',
    empty: '(empty)',
    managed: 'started by the extension',
    external: 'started elsewhere',
    uptime: (s) => `up ${s}`,
    hot: 'applies immediately',
    cold: 'needs a World restart',
    stalePage: 'This page is out of date. Reload it (Ctrl+R) and try again.',
    summaryMissing: '(not read yet)',
  },
};

const SAVE_DEBOUNCE_MS = 400;
const POLL_MS = 5000;

const text = (ctx) => (ctx.language === 'en' ? TEXT.en : TEXT.zh);

function fmtDuration(ms, en) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return en ? `${h}h ${m}m` : `${h} 小时 ${m} 分`;
  if (m) return en ? `${m}m ${s}s` : `${m} 分 ${s} 秒`;
  return en ? `${s}s` : `${s} 秒`;
}

/** 一项在收起状态下的读数。 */
function fieldText(field, value, s) {
  if (field.type === 'boolean') return value ? s.on : s.off;
  if (Array.isArray(field.options)) {
    const hit = field.options.find((o) => o.value === value);
    if (hit) return hit.label;
    return value ? String(value) : s.empty;
  }
  if (value === '' || value === null || value === undefined) return s.empty;
  const raw = String(value);
  return raw.length > 42 ? `${raw.slice(0, 40)}…` : raw;
}

export default {
  panels: {
    settings: { mount },
  },
};

function mount(ctx) {
  const ui = ctx.ui;
  const s = text(ctx);
  const en = ctx.language === 'en';

  let state = null;
  /** 本地值：面板是这些字段的唯一编辑处，保存成功后不回读，避免打字被覆盖。 */
  let values = {};
  /** 每个字段的控件与元数据，收起摘要与刷新音色时要回头找它们。 */
  const bindings = new Map();
  /** 组 id → 待提交的改动（防抖合并）。 */
  const pending = new Map();
  const timers = new Map();
  /** 组 id → { sheet, note }：摘要文字随编辑与状态刷新重算。 */
  const notes = new Map();

  const strip = ui.h('div', 'rowbar');
  const msg = ui.msgline('');
  const groups = ui.h('div');
  const chipBox = ui.h('div', 'bbt-chips');
  const btnBox = ui.h('div', 'bbt-buttons');
  strip.append(chipBox, ui.h('span', 'grow'), btnBox);
  ctx.root.append(strip, msg, groups);

  const testBtn = ui.button(s.test, { variant: 'primary', size: 'sm', onClick: () => void runTest() });
  const startBtn = ui.button(s.start, { size: 'sm', onClick: () => void runStart() });
  const stopBtn = ui.button(s.stop, { size: 'sm', onClick: () => void runStop() });
  const logBtn = ui.button(s.log, { size: 'sm', onClick: () => void showLog() });
  const refreshBtn = ui.button(s.refresh, { size: 'sm', onClick: () => void reload() });
  btnBox.append(testBtn, startBtn, stopBtn, logBtn, refreshBtn);

  groups.appendChild(ui.placeholder(s.loading));

  function setMsg(t, bad) {
    msg.textContent = t || '';
    msg.className = `msgline${bad ? ' bad' : ''}${t ? '' : ' is-hint'}`;
  }

  /** 状态条：服务在不在、谁起的、跑了多久。 */
  function paintStrip() {
    const st = state?.service ?? {};
    chipBox.replaceChildren();
    // 服务在不在用 pill（框架里 on/off 是它的配色），其余读数是中性 chip
    chipBox.appendChild(ui.pill(
      `${s.service}: ${st.running ? (st.phase === 'starting' ? s.starting : s.running) : s.stopped}`,
      st.running ? 'on' : 'off',
    ));
    if (st.running && st.pid) chipBox.appendChild(ui.chip(`pid ${st.pid}`, 'plain'));
    if (st.running && st.health?.sampleRate) chipBox.appendChild(ui.chip(`${st.health.sampleRate} Hz`, 'plain'));
    if (st.running && st.uptimeMs) chipBox.appendChild(ui.chip(fmtDuration(st.uptimeMs, en), 'plain'));
    if (st.running && st.managed) chipBox.appendChild(ui.chip(s.managed, 'plain'));
    else if (st.running) chipBox.appendChild(ui.chip(s.external, 'plain'));
    if (!st.running && st.error) {
      const note = ui.chip(st.error.length > 60 ? `${st.error.slice(0, 58)}…` : st.error, 'warn');
      note.title = st.error;
      chipBox.appendChild(note);
    }
    startBtn.disabled = Boolean(st.running);
    stopBtn.disabled = !st.running || !st.managed;
    stopBtn.title = st.running && !st.managed ? s.external : '';
  }

  /** 一张折叠卡：大标题一行，收起时只剩摘要。 */
  function buildGroup(group) {
    const sheet = ui.foldSheet(group.id, {
      title: group.title,
      desc: group.desc,
      defaultOpen: false,
    });
    sheet.el.dataset.group = group.id;
    // 卡里的小标题（本地服务那张：连接一段、进程一段）
    let section = '';
    for (const field of group.fields) {
      if (field.section && field.section !== section) {
        section = field.section;
        sheet.body.appendChild(ui.h('div', 'bbt-secthead', section));
      }
      sheet.body.appendChild(fieldRow(group, field));
    }
    const note = () => {
      const parts = (group.summary || [])
        .map((path) => {
          const field = group.fields.find((f) => f.path === path);
          return field ? `${field.title} ${fieldText(field, values[path], s)}` : '';
        })
        .filter(Boolean);
      sheet.note.textContent = parts.length ? parts.join(' · ') : '';
    };
    note();
    // 连接与进程现在在同一张卡里：启动命令那块跟着它
    const extra = group.id.endsWith(':local') ? wrapLaunch() : null;
    if (extra) sheet.body.appendChild(extra);
    return { sheet, note };
  }

  /** 服务那张卡多一块：现在会跑什么命令、日志在哪。 */
  function launchBlock() {
    const box = ui.h('div', 'setrow configrow');
    const label = ui.h('div', 'setlabel', s.launchTitle);
    const control = ui.h('div', 'setcontrol');
    const launch = state?.launch ?? {};
    if (launch.ok) {
      const line = ui.h('div', 'configline mono', `${launch.exe} → ${launch.model}`);
      line.title = `${launch.host}:${launch.port}`;
      control.appendChild(line);
      control.appendChild(ui.h('p', 'setnote', `${launch.host}:${launch.port}${launch.logFile ? ` · ${launch.logFile}` : ''}`));
    } else {
      control.appendChild(ui.h('div', 'configline', s.launchMissing));
      control.appendChild(ui.h('p', 'setnote', launch.error || ''));
    }
    box.append(label, control);
    return box;
  }

  function fieldRow(group, field) {
    const row = ui.h('div', 'setrow configrow');
    // 开关行单独排：名称占左边、开关贴右边，两边同一行；
    // 容器变窄时框架会把 setrow 塌成一列，开关就掉到名称下面去了
    if (field.type === 'boolean') row.classList.add('bbt-switchrow');
    const label = ui.h('div', 'setlabel', field.title);
    if (!field.hot) label.appendChild(ui.h('span', 'ttag', s.cold));
    const control = ui.h('div', 'setcontrol');
    const line = ui.h('div', 'configline');
    control.appendChild(line);

    const value = values[field.path];
    if (field.type === 'boolean') {
      line.classList.add('switchbox');
      const box = ui.checkbox('', {
        checked: value === true,
        onChange: (checked) => {
          values[field.path] = checked;
          commit(group.id, field.path, checked);
          refreshNotes();
        },
      });
      box.input.setAttribute('aria-label', field.title);
      line.appendChild(box.el);
      bindings.set(field.path, { field, group, node: box.el, write: (v) => box.setChecked(v === true) });
    } else if (Array.isArray(field.enum) || Array.isArray(field.options)) {
      const options = Array.isArray(field.options)
        ? field.options
        : field.enum.map((v) => ({ value: v, label: v }));
      const sel = ui.select({
        value: typeof value === 'string' ? value : '',
        options,
        onChange: (next) => {
          values[field.path] = next;
          commit(group.id, field.path, next);
          refreshNotes();
        },
      });
      const wrap = ui.h('div', 'tfield');
      wrap.appendChild(sel);
      line.appendChild(wrap);
      bindings.set(field.path, {
        field,
        group,
        node: sel,
        write: (v) => { sel.value = typeof v === 'string' ? v : ''; },
        reoptions: (list) => {
          sel.replaceChildren();
          for (const item of list) {
            const opt = ui.h('option', null, item.label || item.value);
            opt.value = item.value;
            sel.appendChild(opt);
          }
          if (typeof values[field.path] === 'string') sel.value = values[field.path];
        },
      });
      // 音色表在服务那边，给它一颗就地刷新的按钮
      if (field.options) {
        const more = ui.button(s.refreshVoices, {
          size: 'sm',
          onClick: async () => {
            const lock = ui.disable(more);
            try {
              const out = await ctx.invoke('voices.refresh', [en ? 'en' : 'zh']);
              const list = Array.isArray(out?.options) ? out.options : [];
              bindings.get(field.path)?.reoptions?.(list);
              field.options = list;
              setMsg(s.voicesRefreshed(list.length));
            } catch (err) {
              setMsg(String(err?.message ?? err), true);
            } finally {
              lock.dispose();
            }
          },
        });
        more.classList.add('bbt-inline');
        line.appendChild(more);
      }
    } else if (field.type === 'number' || field.type === 'integer') {
      const input = ui.input({
        type: 'number',
        value: value === '' || value === null || value === undefined ? '' : String(value),
        onInput: (raw) => {
          if (raw.trim() === '') return;             // 清空不算改，失焦后仍是原值
          const num = Number(raw);
          if (!Number.isFinite(num)) return;
          values[field.path] = num;
          commit(group.id, field.path, num);
          refreshNotes();
        },
      });
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (field.step !== undefined) input.step = String(field.step);
      const wrap = ui.h('div', 'tfield');
      wrap.appendChild(input);
      if (field.suffix) wrap.appendChild(ui.h('span', 'tunit', field.suffix));
      line.appendChild(wrap);
      bindings.set(field.path, {
        field,
        group,
        node: input,
        write: (v) => { input.value = v === '' || v === null || v === undefined ? '' : String(v); },
      });
    } else {
      const input = ui.input({
        value: typeof value === 'string' ? value : String(value ?? ''),
        cls: field.pick ? 'mono' : undefined,
        onInput: (raw) => {
          values[field.path] = raw;
          commit(group.id, field.path, raw);
          refreshNotes();
        },
      });
      const wrap = ui.h('div', 'tfield');
      wrap.appendChild(input);
      if (field.suffix) wrap.appendChild(ui.h('span', 'tunit', field.suffix));
      line.appendChild(wrap);
      if (field.pick) {
        const pick = ui.button(s.pick, {
          size: 'sm',
          onClick: async () => {
            const picked = await ctx.pickPath({
              kind: field.pick.kind,
              ...(field.pick.extensions ? { extensions: field.pick.extensions } : {}),
              ...(input.value ? { currentPath: input.value } : {}),
              ...(field.pick.recommendedDir ? { recommendedDir: field.pick.recommendedDir } : {}),
            }).catch(() => null);
            if (!picked) return;
            input.value = picked;
            values[field.path] = picked;
            commit(group.id, field.path, picked);
            refreshNotes();
          },
        });
        pick.classList.add('bbt-inline');
        line.appendChild(pick);
      }
      bindings.set(field.path, { field, group, node: input, write: (v) => { input.value = String(v ?? ''); } });
    }

    // 说明是注脚：开关行放到名称下面（右栏只有开关），其余行贴在控件下面
    if (field.desc) {
      const note = ui.h('p', 'setnote', field.desc);
      if (field.type === 'boolean') label.appendChild(note);
      else control.appendChild(note);
    }
    row.append(label, control);
    return row;
  }

  /** 收起状态的摘要跟着改；服务卡里的启动命令也随之作废，重画一次。 */
  function refreshNotes() {
    for (const [, entry] of notes) entry.note();
    const service = notes.get(`world:breezeblue-tts:local`);
    if (service && state) {
      const old = service.sheet.body.querySelector('.bbt-launch');
      if (old) old.replaceWith(wrapLaunch());
    }
  }

  function wrapLaunch() {
    const node = launchBlock();
    node.classList.add('bbt-launch');
    return node;
  }

  function commit(groupId, path, value) {
    const bucket = pending.get(groupId) ?? {};
    bucket[path] = value;
    pending.set(groupId, bucket);
    const timer = timers.get(groupId);
    if (timer) clearTimeout(timer);
    timers.set(groupId, setTimeout(() => void flush(groupId), SAVE_DEBOUNCE_MS));
  }

  async function flush(groupId) {
    const bucket = pending.get(groupId);
    timers.delete(groupId);
    if (!bucket) return;
    pending.delete(groupId);
    setMsg(s.saving);
    try {
      // 写回走 World 自己的 invoke('save')：这份配置只有面板一个入口，不经 /api/config
      const out = await ctx.invoke('save', [groupId, bucket]);
      // 服务端会把越界的数字按 schema 夹回范围：只把刚改过的那几个控件改成存储值，
      // 不整体重画，免得别处正在输入的内容被覆盖
      for (const [path, value] of Object.entries(out?.values ?? {})) {
        if (values[path] === value) continue;
        values[path] = value;
        bindings.get(path)?.write?.(value);
      }
      refreshNotes();
      setMsg(s.saved);
      // 服务地址、exe 这些可能刚被改过：让状态条与启动命令跟上
      void refreshService();
    } catch (err) {
      const why = String(err?.message ?? err);
      // 页面停在旧版本时它还记着已经合并掉的配置组，服务端只会回「未知配置组」：
      // 与其把这句话甩给用户，不如直接说该刷新了
      setMsg(/未知配置组|unknown config group/i.test(why) ? s.stalePage : s.saveFailed(why), true);
    }
  }

  function render(data) {
    state = data;
    values = { ...(data.values || {}) };
    bindings.clear();
    notes.clear();
    groups.replaceChildren();
    for (const group of data.groups || []) {
      const built = buildGroup(group);
      groups.appendChild(built.sheet.el);
      notes.set(group.id, built);
    }
    paintStrip();
  }

  async function reload() {
    try {
      const data = await ctx.invoke('state', [en ? 'en' : 'zh']);
      render(data);
      setMsg('');
    } catch (err) {
      groups.replaceChildren(ui.placeholder(s.loadFailed(String(err?.message ?? err))));
    }
  }

  /** 只刷服务状态：不动表单，免得正在输入的值被回读覆盖。 */
  async function refreshService() {
    try {
      const st = await ctx.invoke('service.status');
      state = { ...(state || {}), service: st, ...(st?.launch ? { launch: st.launch } : {}) };
      paintStrip();
      refreshNotes();
    } catch {
      /* 静默：状态刷不上不该刷屏 */
    }
  }

  async function runTest() {
    const lock = ui.disable(testBtn);
    setMsg(s.loading);
    try {
      const r = await ctx.invoke('test');
      if (r?.ok) setMsg(r.provider === 'local' ? s.testOk(r) : s.testCloudOk(r));
      else setMsg(s.testFail(r?.error || '—'), true);
    } catch (err) {
      setMsg(s.testFail(String(err?.message ?? err)), true);
    } finally {
      lock.dispose();
    }
  }

  async function runStart() {
    // 不用 ui.disable：它会在 dispose 时把 disabled 恢复成"按下之前"的值，
    // 而那时服务已经在跑，按钮该是灰的。起停的可用性统一交给 paintStrip。
    startBtn.disabled = true;
    setMsg(s.startingWait);
    try {
      const r = await ctx.invoke('service.start');
      if (r?.status) state = { ...(state || {}), service: r.status, launch: r.status.launch ?? state?.launch };
      if (r?.ok) setMsg(s.started(r));
      else setMsg(s.startFailed(r?.error || '—'), true);
    } catch (err) {
      setMsg(s.startFailed(String(err?.message ?? err)), true);
    } finally {
      if (!state?.service) startBtn.disabled = false;
      void refreshService();
    }
  }

  async function runStop() {
    const ok = await ui.confirm({
      title: s.stop,
      body: en ? 'The loaded model is dropped; the next start reloads it.' : '会结束这个服务进程，模型下次启动要重新加载。',
      danger: true,
    });
    if (!ok) return;
    stopBtn.disabled = true;
    try {
      const r = await ctx.invoke('service.stop');
      if (r?.status) state = { ...(state || {}), service: r.status, launch: r.status.launch ?? state?.launch };
      if (r?.ok) setMsg(s.stoppedOk);
      else setMsg(s.stopFailed(r?.error || '—'), true);
    } catch (err) {
      setMsg(s.stopFailed(String(err?.message ?? err)), true);
    } finally {
      void refreshService();
    }
  }

  async function showLog() {
    try {
      const out = await ctx.invoke('service.log', [120]);
      const body = ui.h('pre', 'mono');
      body.textContent = out?.lines || s.logEmpty;
      ui.drawer(s.logTitle, body);
    } catch (err) {
      setMsg(String(err?.message ?? err), true);
    }
  }

  void reload();
  ctx.interval(() => void refreshService(), POLL_MS);
}
