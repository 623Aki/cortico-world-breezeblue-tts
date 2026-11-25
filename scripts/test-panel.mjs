/**
 * 设置面板的行为测试：真的把「朗读设置」挂起来，看它是不是默认全折叠、改一项会不会写回、
 * 顶部按钮有没有连上数据面。
 *
 * DOM 用 jsdom（不是本包的依赖，只是测试时的便利），UI 原语用下面这套很小的假实现——
 * 它按框架的类名与结构给节点，所以面板里凡是写错的 DOM 调用都会在这里炸出来。
 *
 * 没有 jsdom 时跳过（打印 skip 而不是失败）：这个包本身零依赖，
 * 需要跑这套用例就指一下：
 *   BBT_JSDOM="G:/AI/_Projects/Coopanion/node_modules/jsdom" node scripts/test-panel.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const JSDOM_HINT = process.env.BBT_JSDOM || '';

async function loadJsdom() {
  const candidates = [JSDOM_HINT, 'jsdom'].filter(Boolean);
  for (const spec of candidates) {
    try {
      const url = spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec) ? pathToFileURL(join(spec, 'lib', 'api.js')).href : spec;
      const mod = await import(url);
      return mod.JSDOM ?? mod.default?.JSDOM ?? null;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const JSDOM = await loadJsdom();

/** 假 UI：只实现面板用到的那几个原语，产出与框架同名的类与结构。 */
function fakeUi(doc) {
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };
  let seq = 0;
  return {
    h: (tag, cls, text) => el(tag, cls ?? '', text ?? null),
    chip: (text, tone) => {
      const node = el('span', `chip${tone && tone !== 'plain' ? ` ${tone}` : ''}`, text);
      return node;
    },
    pill: (text, tone) => el('span', `pill${tone && tone !== 'plain' ? ` ${tone}` : ''}`, text),
    msgline: (text = '', bad = false) => el('div', `msgline${bad ? ' bad' : ''}`, text),
    placeholder: (text) => el('div', 'placeholder', text),
    button: (label, opts = {}) => {
      const node = el('button', `btn${opts.variant && opts.variant !== 'plain' ? ` ${opts.variant}` : ''}${opts.size === 'sm' ? ' sm' : ''}`, label);
      if (opts.onClick) node.addEventListener('click', opts.onClick);
      return node;
    },
    checkbox: (label, opts = {}) => {
      const wrap = el('label', 'check');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = opts.checked === true;
      if (opts.onChange) input.addEventListener('change', () => opts.onChange(input.checked));
      wrap.append(input, doc.createTextNode(label));
      return {
        el: wrap,
        input,
        get checked() { return input.checked; },
        setChecked(v) { input.checked = v === true; },
      };
    },
    select: (opts = {}) => {
      const node = el('select', 'field');
      for (const item of opts.options ?? []) {
        const value = typeof item === 'string' ? item : item.value;
        const text = typeof item === 'string' ? item : (item.label ?? item.value);
        const opt = el('option', '', text);
        opt.value = value;
        node.appendChild(opt);
      }
      node.value = opts.value ?? '';
      if (opts.onChange) node.addEventListener('change', () => opts.onChange(node.value));
      return node;
    },
    input: (opts = {}) => {
      const node = el('input', `field${opts.cls === 'mono' ? ' mono' : ''}`);
      if (opts.type) node.type = opts.type;
      node.value = opts.value ?? '';
      if (opts.onInput) node.addEventListener('input', () => opts.onInput(node.value));
      return node;
    },
    foldSheet: (id, opts = {}) => {
      seq += 1;
      const card = doc.createElement('details');
      card.className = 'sheet tabbed fold';
      card.dataset.foldId = id;
      card.open = opts.defaultOpen === true;
      const summary = el('summary');
      const head = el('h3', '', opts.title ?? '');
      const note = el('span', 'foldnote');
      summary.append(head, note);
      const body = el('div', 'foldbody');
      if (opts.desc) body.appendChild(el('p', 'sh-desc', opts.desc));
      card.append(summary, body);
      return { el: card, body, note, desc: null };
    },
    disable: (...els) => {
      const before = els.map((node) => node.disabled);
      els.forEach((node) => { node.disabled = true; });
      return { dispose() { els.forEach((node, i) => { node.disabled = before[i]; }); } };
    },
    confirm: async () => true,
    drawer: () => ({ dispose() {} }),
    toast: () => ({ dispose() {} }),
    __seq: () => seq,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the settings panel folds every section by default and wires the data plane', { skip: JSDOM ? false : '需要 jsdom：用 BBT_JSDOM 指路' }, async (t) => {
  const world = (await import('../src/index.js')).default;
  const { petVoiceDefaults } = await import('../src/index.js');
  const { petVoiceConfigGroups } = await import('../src/config-schema.js');
  const bundle = (await import('../src/webui/client.js')).default;

  assert.equal(typeof bundle.panels.settings.mount, 'function', '包里要导出 settings 面板');

  const decl = world.create({
    cfg: { enabled: false }, dataDir: '', botDir: '', packageDir: '', repoRoot: '',
    timezone: 'Asia/Shanghai', botName: 'Coo',
    log: { info() {}, warn() {}, error() {}, debug() {} },
    persist() {}, restart() {}, secret: () => '', storeSecret() {},
  }).webUi('zh');
  assert.deepEqual(decl.panels.map((p) => p.id), ['settings'], 'World 页要声明 settings 面板');
  assert.equal(typeof decl.invoke, 'function', '数据面要挂在 webUi() 的返回值上');
  // 交了 config，框架就会在「配置」页签里再画一份按 schema 生成的表单，
  // 和面板抢同一批字段（改一边另一边不动）——所以这里必须是空的
  assert.equal(decl.config, undefined, '不交 config：面板是唯一的设置入口');
  assert.ok(decl.panels.every((p) => p.title), '面板要有标题');

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const ui = fakeUi(doc);
  const dir = mkdtempSync(join(tmpdir(), 'bbt-panel-'));
  // 端口指向一个肯定没人听的地方：状态探测立刻失败，测试不必等 800ms 超时
  const cfg = { ...petVoiceDefaults(), enabled: false, cloudProvider: 'local', localBaseUrl: 'http://127.0.0.1:9' };
  /** ctx.persist 收到的补丁：面板写回应当走到这里，键是段内键（不带 worlds.<id>. 前缀）。 */
  const persisted = [];
  const instance = world.create({
    cfg, dataDir: dir, botDir: dir, packageDir: '', repoRoot: '',
    timezone: 'Asia/Shanghai', botName: 'Coo',
    log: { info() {}, warn() {}, error() {}, debug() {} },
    persist: (patch) => persisted.push(patch), restart() {}, secret: () => '', storeSecret() {},
  });

  const calls = { invoke: [], saves: [] };
  const ctx = {
    pageId: 'world:breezeblue-tts',
    panelId: 'settings',
    language: 'zh',
    root: doc.body,
    ui,
    memo: { get: () => undefined, set() {} },
    scope: {},
    signal: new AbortController().signal,
    invoke: async (method, args) => {
      calls.invoke.push(method);
      if (method === 'save') calls.saves.push(args);
      return instance.invoke('settings', method, args ?? []);
    },
    // 面板不该再走这条路：配置组不再交给 /api/config，setConfig 会 400
    setConfig: async () => {
      throw new Error('面板不该再用 ctx.setConfig：配置组已不再交给 /api/config');
    },
    pickPath: async () => null,
    interval: () => ({ dispose() {} }),
    timeout: () => ({ dispose() {} }),
    frame: () => ({ dispose() {} }),
    own: (d) => d,
    guardLeave: () => ({ dispose() {} }),
    refresh: async () => {},
    notifyOnUnmount() {},
  };

  try {
    await bundle.panels.settings.mount(ctx);
    // 首次读取是异步的：等折叠卡真的画出来（最多 5 秒），而不是盲等一个固定时长
    for (let i = 0; i < 100 && !doc.querySelector('details.sheet'); i += 1) await sleep(50);
    assert.ok(doc.querySelector('details.sheet'), `面板没画出来：${doc.body.textContent.slice(0, 200)}`);

    await t.test('每一组都折着，默认不展开', () => {
      const details = [...doc.querySelectorAll('details.sheet')];
      assert.equal(details.length, petVoiceConfigGroups('zh').length, '每个配置组一张折叠卡');
      assert.ok(details.every((d) => d.open === false), '默认全部收起');
      assert.ok(details.every((d) => d.querySelector('summary h3')?.textContent), '每张卡都有大标题');
    });

    // 调样式时想直接看排布：BBT_DUMP=<输出.html> [BBT_FRAMEWORK_CSS=<控制台的 styles.css>]
    // 会把这张面板连同两边的样式表拼成一个能单独打开的页面。
    if (process.env.BBT_DUMP) {
      const css = [
        process.env.BBT_FRAMEWORK_CSS ? readFileSync(process.env.BBT_FRAMEWORK_CSS, 'utf8') : '',
        readFileSync(new URL('../src/webui/style.css', import.meta.url), 'utf8'),
      ].join('\n');
      // 展开每一张卡，页面上一眼能看到全部字段
      for (const d of doc.querySelectorAll('details.sheet')) d.open = true;
      writeFileSync(process.env.BBT_DUMP, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>朗读设置</title>
<style>${css}</style>
<style>
  body { display: block; height: auto; overflow: auto; padding: 28px 24px 60px; }
  .page { max-width: 940px; margin: 0 auto; }
</style></head>
<body><div class="page">${doc.body.innerHTML}</div></body></html>\n`);
    }

    await t.test('分组顺序：两个云端相邻，本地服务合成一张卡', () => {
      const ids = [...doc.querySelectorAll('details.sheet')].map((d) => d.dataset.group);
      const iBreeze = ids.indexOf('world:breezeblue-tts:breeze');
      const iMini = ids.indexOf('world:breezeblue-tts:minimax');
      assert.ok(iBreeze >= 0 && iMini === iBreeze + 1, `两个云端要挨着：${ids.join(' → ')}`);
      assert.ok(!ids.includes('world:breezeblue-tts:service'), '旧的「本地服务进程」卡应当并进本地卡');
      const local = doc.querySelector('details.sheet[data-group="world:breezeblue-tts:local"]');
      assert.ok(local, '本地服务卡还在');
      assert.ok([...local.querySelectorAll('.bbt-secthead')].length >= 1, '本地卡里要有「进程」分节标题');
      // 连接（服务类型/地址/音色…）与进程（exe/模型/参数…）在同一张卡里
      assert.ok(local.querySelectorAll('.setrow').length >= 12, `本地卡字段数：${local.querySelectorAll('.setrow').length}`);
    });

    await t.test('开关在名称前面，说明挂在名称下面', () => {
      const row = doc.querySelector('.setrow.bbt-switchrow');
      assert.ok(row, '开关行要带 bbt-switchrow（框架的 grid 会把控件甩到右边缘）');
      assert.ok(row.querySelector('.setlabel > .setnote'), '说明放进名称里，右栏只留开关');
      assert.ok(row.querySelector('.setcontrol input[type=checkbox]'), '开关在控件栏');
      // 位置靠 CSS 定，jsdom 算不出布局：守住「把控件提到视觉第一位」这条
      // （DOM 顺序仍是名称在前，读屏与 label 关联不变）
      const css = readFileSync(new URL('../src/webui/style.css', import.meta.url), 'utf8');
      assert.match(
        css,
        /\.setrow\.bbt-switchrow\s*>\s*\.setcontrol\s*\{[^}]*order:\s*-1/,
        '开关要排在名称左边；放到右边缘就分不清它属于哪一项了',
      );
    });

    // 回归断言：面板曾经用完整路径（worlds.breezeblue-tts.foo）去读 ctx.cfg，
    // 而 ctx.cfg 只是那一段，于是每个输入框都是空的——配置页有值、面板是空。
    await t.test('面板读到的是配置里的值，不是空', () => {
      const rows = [...doc.querySelectorAll('details.sheet .setrow')];
      const row = rows.find((r) => r.querySelector('.setlabel')?.textContent?.trim() === '服务地址');
      assert.ok(row, '找得到「服务地址」这一行');
      assert.equal(row.querySelector('input')?.value, 'http://127.0.0.1:9', '读到的应当是 cfg 里的值');
      const box = doc.querySelector('details input[type=checkbox][aria-label="开启朗读"]');
      assert.equal(box.checked, false, '开关要反映 cfg.enabled');
    });

    await t.test('收起时显示摘要', () => {
      const notes = [...doc.querySelectorAll('details.sheet .foldnote')].map((n) => n.textContent.trim());
      assert.ok(notes.filter(Boolean).length >= 5, `至少一半的卡有摘要：${JSON.stringify(notes)}`);
      const base = notes[0];
      assert.match(base, /开|关/, '第一张卡摘要里有朗读开关');
    });

    await t.test('字段按类型渲染成控件', () => {
      const select = doc.querySelectorAll('details select');
      const input = doc.querySelectorAll('details input');
      assert.ok(select.length >= 8, `下拉数量：${select.length}`);
      assert.ok(input.length >= 20, `输入框数量：${input.length}`);
      // 布尔值是开关
      const boxes = [...doc.querySelectorAll('details input[type=checkbox]')];
      assert.ok(boxes.length >= 6, '布尔项应当是勾选框');
    });

    await t.test('改一项就写回，而且只提交改过的那一个键', async () => {
      const box = doc.querySelector('details input[type=checkbox][aria-label="开启朗读"]');
      assert.ok(box, '找得到「开启朗读」的开关');
      box.checked = true;
      box.dispatchEvent(new dom.window.Event('change'));
      await sleep(600);
      const last = calls.saves.at(-1);
      assert.ok(last, '应当发出一次保存');
      assert.equal(last[0], 'world:breezeblue-tts');
      assert.deepEqual(last[1], { 'worlds.breezeblue-tts.enabled': true });
      assert.deepEqual(persisted.at(-1), { enabled: true }, '写回要转成段内键交给 ctx.persist');
    });

    await t.test('顶部按钮连到数据面', async () => {
      const buttons = [...doc.querySelectorAll('.rowbar button')].map((b) => b.textContent);
      assert.deepEqual(buttons, ['测试连接', '启动服务', '停止服务', '日志', '刷新']);
      const testBtn = [...doc.querySelectorAll('.rowbar button')].find((b) => b.textContent === '测试连接');
      testBtn.dispatchEvent(new dom.window.Event('click'));
      await sleep(1200);
      assert.ok(calls.invoke.includes('test'), '测试连接要打到 invoke(test)');
      // 服务没起的时候「停止」按不动
      const stopBtn = [...doc.querySelectorAll('.rowbar button')].find((b) => b.textContent === '停止服务');
      assert.equal(stopBtn.disabled, true);
    });

    await t.test('状态条说明服务在不在', () => {
      const chips = [...doc.querySelectorAll('.rowbar .chip, .rowbar .pill')].map((c) => c.textContent);
      assert.ok(chips.some((c) => /^服务/.test(c)), `状态条：${JSON.stringify(chips)}`);
      assert.ok(chips.some((c) => /未运行/.test(c)), '服务没起时要说明未运行');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
