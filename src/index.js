/**
 * cortico-world-breezeblue-tts —— Coopanion 扩展（kind: world, api: 6）
 *
 * 干什么：盯着 Coopanion 事件库里桌宠自己记的 desktop-pet.self 事件，把 meta.kind 为 say
 * 的 beats[].text（＝气泡里逐段显示的文字）交给语音合成念出来。
 * 声音来源可选 BreezeBlue / MiniMax 云端 TTS，失败或缺少配置时自动改用
 * Windows 自带语音（System.Speech / SAPI）。默认关。
 *
 * 为什么这么接：Coopanion 0.2.1 的 World 接口不允许一个 World 订阅另一个 World 的工具调用
 * 或事件，pet_say 也没有推出任何事件（桌宠把它记成 archive-only 的 self 事件）。事件库是
 * 唯一能稳定拿到"气泡显示过什么"的地方。详细依据见 README「依赖的契约」。
 *
 * 密钥：绝不写死。从环境变量或部署目录的 .env 读（见 src/secrets.js），日志一律脱敏。
 */
import { createEventWatcher, resolveDataDir, currentEventsFile } from './events.js';
import { createSpeech, probeEngines } from './speech.js';
import { createSpeaker } from './queue.js';
import { createAudioHost } from './audio-host.js';
import { createLocalService } from './service.js';
import { petVoiceConfigGroups, OPTION_KINDS, WORLD_ID } from './config-schema.js';
import { clampInt } from './config.js';
import { createLog } from './log.js';
import { CHINESE_VOICES } from './cloud.js';
import { localBaseUrl, probeLocal, synthesizeLocal } from './local.js';
import { prepareVoiceLibrary, localVoiceOptions, localVoiceOptionsFromDeployment, refreshVoiceLibrary, voiceCount, rememberVoices } from './voice-library.js';

/** 默认关。加进 config.json 也不改变行为，直到有人在控制台或 config.json 里打开。 */
function defaults() {
  return {
    enabled: false,
    // 声音来源：auto = 云端优先，失败回退系统语音；sapi = 只用系统语音
    fallback: 'auto',
    readAsk: true,
    minChars: 1,
    maxChars: 220,

    cloudProvider: 'breeze',
    breezeEnabled: true,
    breezeApiKey: '',
    breezeApiKeyEnv: '',
    breezeVoice: '',
    breezeModel: 'breeze-tts-2',
    breezeLanguageCode: '',
    breezeInstructions: '',
    breezeSpeed: 1,
    breezeVolume: 1,
    breezeGuidanceScale: 1,
    breezeSpeakerBoost: false,
    breezeTimeoutMs: 15000,

    // 本机 breeze-tts-2.cpp 服务（不需要密钥）
    // localKind：本机服务的类型。现在只有 breeze-tts；以后接别的服务时按它分叉，
    // 连接参数暂时共用一套（地址 / 音色 / 指令 / 超时），差异再按类型加字段。
    localKind: 'breeze-tts',
    localEnabled: true,
    localBaseUrl: 'http://127.0.0.1:8137',
    localVoice: '',
    localInstruction: '',
    localCfgScale: 1,
    localSeed: 42,
    localTimeoutMs: 60000,
    // 服务进程由扩展起停：路径留空＝用上次成功的那个，或去 exe 旁边找
    localServiceExe: '',
    localServiceModel: '',
    localServiceArgs: '--chunk-max 40',
    localServiceVoicesDir: '',
    localAutoStart: false,

    // MiniMax 云端
    minimaxEnabled: true,
    minimaxEndpoint: 'cn',
    minimaxModel: 'speech-2.8-turbo',
    minimaxVoice: 'female-shaonv',
    minimaxSpeed: 1,
    minimaxVolume: 1,
    minimaxPitch: 0,
    minimaxEmotion: '',
    minimaxSampleRate: '32000',
    minimaxLanguageBoost: 'auto',
    minimaxFormat: 'wav',
    minimaxTimeoutMs: 15000,
    // key 的读取方式：这里只放"去哪个环境变量找"，key 本身不放代码里
    minimaxApiKeyEnv: '',
    minimaxApiKey: '',
    minimaxGroupId: '',

    // 系统语音（回退）
    sapiVoice: '',
    sapiRate: 0,
    sapiVolume: 100,

    // 其它
    dataDir: '',
    replayExisting: false,
    playTimeoutSec: 60,
    verbose: false,
  };
}

/** 动态下拉：MiniMax 音色。world.configOptions 与实例的 configOptions() 共用这一份。 */function minimaxVoiceOptions() {
  return [
    ...CHINESE_VOICES.map((v) => ({ value: v.id, label: `${v.label}（${v.id}）` })),
    // 复刻/自建音色不在固定表里，给一个空项提示可以直接填 ID
    { value: '', label: '（留空＝少女音色 female-shaonv；也可直接填自己的音色 ID）' },
  ];
}

/**
 * 面板里每张折叠卡收起时显示哪几项（完整的配置路径）。
 * 收起状态只有一行字，所以只挑「一眼判断这块现在是什么状态」的字段。
 */
const P = (name) => `worlds.${WORLD_ID}.${name}`;
const K_PREFIX = `worlds.${WORLD_ID}.`;

/**
 * 完整配置路径 → 段内键。
 *
 * 面板沿用了 schema 的点分路径当字段 id（`worlds.breezeblue-tts.enabled`），因为那套表
 * 本来是给框架的配置页用的；但 `ctx.cfg` 只是 `worlds.breezeblue-tts` 这一段，读值、
 * 写值都要先把前缀去掉。写回走 `ctx.persist()`，它同样要段内键。
 */
function sectionKey(path) {
  return path.startsWith(K_PREFIX) ? path.slice(K_PREFIX.length) : path;
}

/**
 * 按 schema 把面板交来的值转成存储类型。
 * 输入框可以手打超出范围的数字（min/max 只管箭头），这里按声明夹一下；枚举不在表里就拒绝，
 * 免得把不认识的 provider 写进配置。
 */
function coerceField(path, prop, raw) {
  const label = prop.title || path;
  if (prop.type === 'boolean') return raw === true;
  if (prop.type === 'string') {
    const value = String(raw ?? '');
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) {
      throw new Error(`${label} 只能是 ${prop.enum.join(' / ')}`);
    }
    return value;
  }
  if (prop.type === 'integer' || prop.type === 'number') {
    const num = Number(raw);
    if (!Number.isFinite(num)) throw new Error(`${label} 需要是数字`);
    let value = prop.type === 'integer' ? Math.round(num) : num;
    if (prop.minimum !== undefined) value = Math.max(prop.minimum, value);
    if (prop.maximum !== undefined) value = Math.min(prop.maximum, value);
    return value;
  }
  return raw;
}

/**
 * defaults() 的只读快照：面板读值时的兜底。
 *
 * 加载已有的 config.json 时框架不补默认值（`worlds[<id>]` 段在就原样用），所以后来新增
 * 的键在老配置里根本没有；不回退的话面板会把这些项一律显示成空，看着像没配。
 */
const DEFAULTS = defaults();

const PANEL_SUMMARY = {
  [`world:${WORLD_ID}`]: [P('enabled'), P('cloudProvider'), P('fallback')],
  [`world:${WORLD_ID}:breeze`]: [P('breezeEnabled'), P('breezeVoice')],
  [`world:${WORLD_ID}:minimax`]: [P('minimaxEnabled'), P('minimaxVoice')],
  // 本机服务只给一句能判断"能不能出声"的：类型、地址、自动拉起
  [`world:${WORLD_ID}:local`]: [P('localKind'), P('localBaseUrl'), P('localAutoStart')],
  [`world:${WORLD_ID}:sapi`]: [P('sapiVoice'), P('sapiRate')],
  [`world:${WORLD_ID}:advanced`]: [P('maxChars'), P('verbose')],
};

/** 念一句的实例。 */
class PetVoiceWorld {
  constructor(ctx) {
    this.id = WORLD_ID;
    this.cfg = ctx.cfg;
    this.ctx = ctx;
    this.dataDir = resolveDataDir(ctx.dataDir);
    // 音色库缓存放在部署目录里：面板要选项时同步取，不用等网络
    prepareVoiceLibrary(this.dataDir, this.cfg);
    this.host = null;
    this.audioHost = null;
    this._log = createLog(null, ctx);
    this.watcher = null;
    this.speaker = null;
    this.speech = null;
    this.probe = null;
    this.serviceInfo = null;
    this.lastError = '';
    this.lastSpokenAt = 0;
    this.lastSpokenText = '';
    this.endedReason = null;

    // 本机服务的进程管家：面板上的「启动 / 停止 / 看日志」都归它。
    // 构造时就建好，面板在 World 没激活时也能看状态（只是不自动起服务）。
    this.service = createLocalService({
      getConfig: () => this.cfg,
      dataDir: this.dataDir,
      log: (level, msg) => this.logAt(level, msg),
    });

    // 扩展的 World 默认没有 enabled 字段（persona 的 declares 里只列了内建 World），
    // 所以它默认是"未激活"。这里说清楚一点：配置页要激活后才出现。
    if (this.cfg.enabled !== true) {
      this.logAt('info', 'cortico-world-breezeblue-tts 已安装但未激活：到控制台「World」页点它的电源按钮激活后，才会出现「气泡朗读」配置页（朗读开关仍默认关）');
    }
  }

  /** 环境模板：本 World 不给 bot 任何环境信息（默认没有 role=envPrompt 的模板，返回 null 更明确）。 */
  envPromptVars() { return null; }

  /** 不给模型任何工具：这个 World 只旁听，模型看不见它。 */
  tools() { return []; }

  /** 按语言给配置表单（WorldDefinition.configOptions 之外，实例也提供一份动态选项）。 */
  configOptions(kind, language = 'zh') {
    if (kind === OPTION_KINDS.minimaxVoice) return minimaxVoiceOptions();
    // 本机音色库要读 cfg（服务地址）和部署目录里的缓存，只有实例知道
    if (kind === OPTION_KINDS.localVoice) return localVoiceOptions(this.cfg, language);
    return [];
  }

  /**
   * 控制台里这一页的内容。
   *
   * 页签顺序是「面板 → 配置 → 提示词 → 数据」，所以面板排在最前面，进去先看到的是
   * 「朗读设置」那张折叠卡：大标题一行行收着，要改哪一块再展开；顶部还有测试连接与
   * 启停服务的按钮。
   *
   * **不交 `config`**：交出去的话框架会按 JSON Schema 在「配置」页签里再画一份一模一样的
   * 表单——同一个字段两个入口，改一边另一边不动，还常见到「面板是空、配置页有值」。
   * 那套表单只有字段、放不下按钮，也不折叠，四十多项要一路翻到底。所以设置只有面板这一个
   * 入口：字段表（src/config-schema.js）仍留在实例里当渲染描述，写回走 invoke('save') →
   * ctx.persist()，不经过校验「组必须在 config 里」的 /api/config。
   * 不交 config 时框架也不会生成「配置」页签（webui-pages/host.ts 的 tabsOf）。
   *
   * 声明 panels 就**必须**有 `cortico.webUiClient` 指向的浏览器产物（package.json 里指向
   * src/webui/client.js）。没有产物时面板会换成错误卡（webui-pages/loader.ts 的 noBundle），
   * 而 World 页正是激活这个 World 的地方——所以产物要跟包一起发，不能只放源码里。
   */
  webUi(language = 'zh') {
    const en = language === 'en';
    const on = this.cfg.enabled === true;
    const s = this.speaker?.stats() ?? {};
    const sp = this.speech?.status?.() ?? {};
    const state = !on ? 'offline' : (this.endedReason ? 'error' : 'online');
    const engineName = sp.provider === 'local' ? (en ? 'local' : '本地') : (en ? 'cloud' : '云端');
    const engineLabel = !on ? (en ? 'off' : '关')
      : sp.mode === 'auto' && sp.cloudReady
        ? (sp.breakUntil ? (en ? 'fallback' : '回退中') : engineName)
        : (en ? 'system voice' : '系统语音');
    const localOn = this.cfg.cloudProvider === 'local';
    const svc = this.serviceInfo;
    return {
      label: en ? 'BreezeBlue bubble speech' : 'BreezeBlue 气泡朗读',
      panels: [{
        id: 'settings',
        title: en ? 'Speech settings' : '朗读设置',
        description: en
          ? 'Folded by section: open the one you want to change. Buttons on top test the connection and start or stop the local service.'
          : '按大标题折叠：要改哪一块再展开。顶部可以直接测试连接、起停本机服务。',
      }],
      // 面板的数据面要挂在 webUi() 的返回值上（框架按页取 c.invoke），不是实例方法
      invoke: (panel, method, args) => this.invoke(panel, method, args ?? []),
      // 故意不给 config：给了就多出一个自动生成的「配置」页签，和面板重复
      badges: [
        { label: en ? 'State' : '状态', value: engineLabel, tone: on ? (sp.mode === 'auto' && sp.cloudReady ? 'on' : 'plain') : 'off' },
        // 选本机服务时先说服务在不在：起没起来决定能不能出声
        ...(localOn && svc
          ? [{
            label: en ? 'Service' : '服务',
            value: svc.running ? (en ? 'up' : '运行中') : (en ? 'down' : '未运行'),
            tone: svc.running ? 'on' : 'off',
          }]
          : []),
        { label: en ? 'Cloud' : '云端', value: s.cloudSpoken ?? 0 },
        { label: en ? 'Fallback' : '回退', value: s.fellBack ?? 0 },
        { label: en ? 'Waiting' : '排队', value: s.queued ?? 0 },
        // 选本机服务时多给一个音色库数量：0 就是服务没起或还没读过
        ...(localOn ? [{ label: en ? 'Voices' : '音色库', value: voiceCount(this.cfg) }] : []),
      ],
      lamps: [{
        label: en ? 'Bubble speech' : '气泡朗读',
        state,
        hint: !on
          ? (en ? 'Off. Turn on "Read bubbles aloud" on this page.' : '已关闭。在本页配置里打开「开启朗读」。')
          : (this.endedReason
            ?? (sp.mode === 'sapi'
              ? (en ? 'System voice selected.' : '已选择系统语音。')
              : (sp.cloudReady
                ? `${sp.providerLabel ?? ''} ${sp.model ?? ''}${sp.breakUntil ? (en ? ' (cooling down)' : '（熔断中，暂用系统语音）') : ''}`
                : (sp.provider === 'local'
                  ? (en ? 'Local service unreachable: using system voice.' : '本地服务没有响应：正在用系统语音。')
                  : (en ? 'Missing API key or voice ID: using system voice.' : '缺少 API key 或音色 ID：正在用系统语音。'))))),
      }],
    };
  }

  /** 两个引擎各自的状态：key 有没有、系统语音几个、播放器行不行。 */
  async engineReport() {
    const cfg = this.cfg;
    this.probe = await probeEngines(cfg, { botDir: this.dataDir, dataDir: this.dataDir });
    // 探测顺手带回了音色表，直接更新缓存，省一次 /v1/voices
    if (this.probe.local?.ok && this.probe.local.voices?.length) {
      rememberVoices(this.probe.local.base, this.probe.local.voices);
    }
    return { ok: true, ...this.probe, speech: this.speech?.status?.() ?? {} };
  }

  /** 现在在读哪个文件、念了多少、上次错在哪。 */
  statusReport() {
    const w = this.watcher?.state() ?? { file: null, offset: 0 };
    const s = this.speaker?.stats() ?? {};
    const sp = this.speech?.status?.() ?? {};
    const file = w.file ?? currentEventsFile(this.dataDir);
    return {
      enabled: this.cfg.enabled === true,
      dataDir: this.dataDir,
      eventsFile: file,
      offset: w.offset,
      engineMode: sp.mode ?? this.cfg.fallback,
      cloudConfigured: sp.cloudConfigured ?? false,
      keyFrom: sp.keyFrom ?? null,
      breakUntil: sp.breakUntil ?? null,
      lastCloudError: sp.lastCloudError ?? '',
      spoken: s.spoken ?? 0,
      cloudSpoken: s.cloudSpoken ?? 0,
      sapiSpoken: s.sapiSpoken ?? 0,
      fellBack: s.fellBack ?? 0,
      dropped: s.dropped ?? 0,
      failed: s.failed ?? 0,
      queued: s.queued ?? 0,
      lastEngine: s.lastEngine ?? '',
      lastError: s.lastError || this.lastError,
      lastSpokenAt: this.lastSpokenAt,
      lastSpokenText: this.lastSpokenText,
      endedReason: this.endedReason,
    };
  }

  /** 「会跑什么」的摘要：面板显示启动命令、判断能不能起，都看它。 */
  launchSummary() {
    const launch = this.service.resolveLaunch();
    return launch.ok
      ? { ok: true, exe: launch.exe, model: launch.model, host: launch.host, port: launch.port, logFile: launch.logFile }
      : { ok: false, error: launch.error };
  }

  /** 面板要的全部数据：当前值、按组切好的字段表、服务状态、动态选项。 */
  async panelState(language = 'zh') {
    const values = {};
    const groups = [];
    for (const group of petVoiceConfigGroups(language)) {
      const fields = [];
      for (const [path, prop] of Object.entries(group.schema.properties || {})) {
        // cfg 就是 worlds.breezeblue-tts 这一段：路径要去掉前缀才读得到值；
        // 段里没有的键（老配置没写过）退回 defaults()，免得显示成空
        const key = sectionKey(path);
        const raw = this.cfg[key] ?? DEFAULTS[key];
        values[path] = raw === undefined || raw === null ? '' : raw;
        const field = {
          path,
          title: prop.title || path,
          desc: prop.description ?? '',
          type: prop.type === 'boolean' || prop.type === 'number' || prop.type === 'integer' ? prop.type : 'string',
          hot: prop['x-hot'] !== false,
        };
        if (Array.isArray(prop.enum)) field.enum = prop.enum;
        // 动态下拉（音色）在服务端算好一起发：面板不直连 /api，也不用关心 kind 名
        if (prop['x-options']) {
          try {
            field.options = this.configOptions(prop['x-options'], language) || [];
          } catch {
            field.options = [];
          }
        }
        if (prop.minimum !== undefined) field.min = prop.minimum;
        if (prop.maximum !== undefined) field.max = prop.maximum;
        if (prop.multipleOf !== undefined) field.step = prop.multipleOf;
        if (prop['x-suffix']) field.suffix = prop['x-suffix'];
        if (prop['x-path']) field.pick = prop['x-path'];
        // 同一张卡里的小标题：这一项之前插一行分节（进程那段靠它隔开）
        if (prop['x-section']) field.section = prop['x-section'];
        fields.push(field);
      }
      const summary = PANEL_SUMMARY[group.id] ?? [];
      groups.push({
        id: group.id,
        title: group.schema.title || group.id,
        desc: group.schema.description ?? '',
        summary: summary.filter((path) => path in values),
        fields,
      });
    }

    const service = await this.service.status();
    this.serviceInfo = service;
    return {
      language,
      values,
      groups,
      runtime: {
        provider: this.cfg.cloudProvider,
        enabled: this.cfg.enabled === true,
        fallback: this.cfg.fallback === 'sapi' ? 'sapi' : 'auto',
        voices: voiceCount(this.cfg),
        speech: this.speech?.status?.() ?? {},
      },
      service,
      launch: this.launchSummary(),
    };
  }

  /**
   * 面板写回：`{ 'worlds.breezeblue-tts.localServiceExe': '…' }` → `ctx.persist()`。
   *
   * 为什么不走 `/api/config`：那条路要求提交的组出现在 `webUi().config` 里，而这里故意
   * 不交 config（交了就多一份自动生成的表单）。`persist` 把补丁深合并进 `worlds.<id>`，
   * 活配置与 config.json 一起改，下一次读取就是新值——所以「改完立刻生效」照旧成立。
   *
   * 值在这里按 schema 再转一次类型：面板的输入框允许手打，超出 min/max 的按声明夹住，
   * 枚举不认识就拒绝（不把拼错的 provider 写进配置）。
   */
  saveValues(groupId, values) {
    const group = petVoiceConfigGroups('zh').find((g) => g.id === groupId);
    if (!group) throw new Error(`没有这个配置组：${groupId}`);
    const props = group.schema.properties || {};
    const body = values && typeof values === 'object' ? values : {};
    const patch = {};
    const echo = {};
    for (const [path, raw] of Object.entries(body)) {
      const prop = props[path];
      if (!prop) throw new Error(`「${group.schema.title || groupId}」里没有这一项：${path}`);
      const value = coerceField(path, prop, raw);
      patch[sectionKey(path)] = value;
      echo[path] = value;
    }
    if (Object.keys(patch).length) this.ctx.persist(patch);
    return { ok: true, group: groupId, values: echo };
  }

  /**
   * 「测试连接」：本机服务真的合成一句（不播放）再回报时延；云端只看配置，
   * 不发起计费请求——测试连接不该花钱。
   */
  async testConnection() {
    const cfg = this.cfg;
    const provider = cfg.cloudProvider;
    if (provider === 'local') {
      const base = localBaseUrl(cfg);
      const health = await probeLocal(cfg, { timeoutMs: 1500 });
      if (!health.ok) return { ok: false, provider, stage: 'health', base, error: health.error };
      if (health.voices?.length) rememberVoices(health.base, health.voices);
      const synth = await synthesizeLocal('你好。', { ...cfg, localTimeoutMs: Math.min(Number(cfg.localTimeoutMs) || 60000, 20000) });
      if (!synth.ok) {
        return {
          ok: false, provider, stage: 'speech', base,
          sampleRate: health.sampleRate, voices: health.voices?.length ?? 0,
          error: synth.error,
        };
      }
      return {
        ok: true, provider, stage: 'speech', base,
        sampleRate: health.sampleRate,
        wsPort: health.wsPort,
        voices: health.voices?.length ?? 0,
        ms: Math.round(synth.ms ?? 0),
        audioMs: synth.usage?.audioMs ?? null,
        voice: synth.voiceId ?? (cfg.localVoice || 'design'),
      };
    }
    const report = await this.engineReport();
    const cloud = report.cloud ?? {};
    return {
      ok: Boolean(cloud.ready),
      provider,
      stage: 'config',
      label: cloud.label,
      model: cloud.model,
      voice: cloud.voice,
      hasKey: Boolean(cloud.hasKey),
      keyFrom: cloud.keyFrom ?? null,
      endpoint: cloud.endpoint ?? null,
      sapi: report.sapi ?? null,
      error: cloud.ready ? '' : `缺少 ${cloud.label} 的 API key 或音色 ID（只检查配置，不发起计费请求）`,
    };
  }

  /**
   * 面板的数据面（`World.webUi().invoke`）。
   * 只有 POST；错误抛出去，面板按消息显示在状态行里。
   */
  async invoke(panel, method, args = []) {
    if (panel !== 'settings') throw new Error(`没有这个面板：${panel}`);
    switch (method) {
      case 'state':
        return this.panelState(args[0] === 'en' ? 'en' : 'zh');
      case 'save':
        return this.saveValues(args[0], args[1]);
      case 'test':
        return this.testConnection();
      case 'service.status': {
        const status = await this.service.status();
        this.serviceInfo = status;
        return { ...status, launch: this.launchSummary() };
      }
      case 'service.start': {
        const result = await this.service.start();
        this.serviceInfo = await this.service.status();
        return { ...result, status: { ...this.serviceInfo, launch: this.launchSummary() } };
      }
      case 'service.stop': {
        const result = await this.service.stop();
        this.serviceInfo = await this.service.status();
        return { ...result, status: { ...this.serviceInfo, launch: this.launchSummary() } };
      }
      case 'service.log': {
        const status = await this.service.status();
        this.serviceInfo = status;
        return { lines: this.service.logTail(Number(args[0]) || 80), status: { ...status, launch: this.launchSummary() } };
      }
      case 'voices.refresh': {
        await refreshVoiceLibrary(this.cfg, { force: true });
        return { options: localVoiceOptions(this.cfg, args[0] === 'en' ? 'en' : 'zh') };
      }
      default:
        throw new Error(`没有这个方法：${method}`);
    }
  }

  async start(host) {
    this.host = host;
    // 挂载后就有框架的 Logger 了，从这里开始走它（进运行日志 log.jsonl）。
    this._log = createLog(host, this.ctx);
    const cfg = this.cfg;

    // 常驻音频进程：本机服务边生成边发音频，有了它第一块音频到就能出声，
    // 不用等整句合成完，也不用每句都起一个 PowerShell（启动就要 1 秒以上）。
    this.audioHost = createAudioHost({ log: (level, msg) => this.logAt(level, msg) });

    // 朗读引擎与串行队列：一直在，开关只决定"要不要往里塞句子"。
    this.speech = createSpeech({
      getConfig: () => this.cfg,
      opts: { botDir: this.dataDir, dataDir: this.dataDir },
      log: (level, msg) => this.logAt(level, msg),
      engines: { audioHost: this.audioHost },
    });
    this.speaker = createSpeaker({
      speak: (text) => this.speech.speak(text),
      onEvent: (e) => this.onSpeakerEvent(e),
    });

    // 音色库：挂载时后台读一次，面板的「音色 ID」下拉就有选项了。
    // 服务没起只是选项空，不影响朗读（配置里已有 id 也能照旧用）。
    if (cfg.localEnabled !== false) void refreshVoiceLibrary(cfg).catch(() => {});

    // 服务进程：面板上「World 启动时自动拉起」打开时，这里起一次。
    // 不 await：模型加载十几秒，卡住挂载会让整个 World 变成超时失败；失败只写日志。
    if (cfg.localAutoStart === true && cfg.localEnabled !== false && cfg.cloudProvider === 'local') {
      void this.service.start().then((r) => {
        if (r.ok && r.already) this.logAt('info', '本机语音服务本来就在运行');
        else if (!r.ok) this.logAt('warn', `自动启动本机语音服务没成功：${r.error}`);
      }).catch((err) => this.logAt('warn', `自动启动本机语音服务出错：${err?.message ?? err}`));
    }

    // 播放进程也提前拉起来：编译 + 开设备的几百毫秒放在挂载时付，第一句才不慢。
    if (this.cfg.cloudProvider === 'local') {
      void this.audioHost.warm(24000).then((boot) => {
        if (boot.ok) this.logAt('info', `流式播放进程就绪（${boot.sampleRate} Hz，启动 ${this.audioHost.status().readyMs} ms）`);
        else this.logAt('warn', `流式播放进程没起来：${boot.error}；将退回整段播放`);
      }).catch(() => {});
    }

    if (cfg.enabled !== true) {
      this.logAt('info', '气泡朗读已装好但没打开（worlds.breezeblue-tts.enabled = false）');
      return;
    }

    // 起来探一次引擎，好让面板和日志有话可说。探不到不算致命：可能没配 key、沙箱挡了
    // 音频设备、或这台机器没有语音包；都只影响发声，不该拦住 World 挂载。
    try {
      const report = await this.engineReport();
      const cloud = report.cloud ?? {};
      const local = report.local;
      const sapi = report.sapi ?? {};
      if (cloud.provider === 'local') {
        this.logAt('info', local?.ok
          ? `本地服务可用：${local.base}（${local.voices?.length ?? 0} 个音色，${local.sampleRate ?? '?'} Hz）；音色 ${cloud.voice || '留空＝按演绎指令设计'}`
          : `本地服务连不上：${local?.error ?? cloud.endpoint}；将只用系统语音`);
      } else {
        this.logAt('info', cloud.hasKey
          ? `${cloud.label} key 已配置：来自 ${cloud.keyFrom}，模型 ${cloud.model}，音色 ${cloud.voice || '未填写'}${cloud.ready ? '' : '；将只用系统语音'}`
          : `没找到 ${cloud.label} API key（找过：${(cloud.candidates ?? []).join(' / ')}，以及部署目录的 .env）；将只用系统语音`);
      }
      this.logAt('info', sapi.ok
        ? `系统语音可用（${sapi.voiceCount} 个音色），作为回退`
        : `系统语音不可用：${sapi.error ?? '未知原因'}（所选引擎成功时不影响）`);
      if (cloud.ready && report.player && report.player.ok === false) {
        this.logAt('warn', `本地播放器探测失败：${report.player.error}；合成可能放不出声`);
      }
    } catch (err) {
      this.logAt('warn', `探测语音引擎出错：${err?.message ?? err}`);
    }

    if (!this.dataDir) {
      this.endedReason = '找不到部署目录（dataDir）';
      this.logAt('error', `${this.endedReason}；请在控制台把「事件目录」填成 Coopanion 的部署目录（含 config.json、.env 与 data\\runs）`);
      return;
    }

    this.watcher = createEventWatcher({
      dataDir: this.dataDir,
      replayExisting: cfg.replayExisting === true,
      // 轮询间隔直接决定"文字出现 → 开始合成"的延迟。500ms 太钝：一次轮询就是
      // 半秒的错位，而这里只是 stat + 读新增字节，150ms 完全承受得起。
      pollMs: 150,
      onLog: (level, msg) => this.logAt(level, msg),
      onText: (text) => this.onBubbleText(text),
    });
    await this.watcher.start();
    this.endedReason = null;
    this.logAt('info', `气泡朗读已启动：${this.dataDir}`);
  }

  async stop() {
    this.watcher?.stop();
    this.watcher = null;
    this.speaker?.stop();
    this.speaker = null;
    this.speech = null;
    await this.audioHost?.dispose();
    this.audioHost = null;
    // 放句柄并安排停止：World 重启会在宽限期内把 start() 叫回来（撤销），
    // 而 Coopanion 退出时没有 start() 会来，服务就跟着走——不然几百 MB 内存和
    // 显存会一直挂着，还是个没窗口的隐形进程，很容易忘。
    this.service?.dispose();
    this.logAt('info', '气泡朗读已停止');
  }

  /** 一条该念的文本从事件库里出来了。 */
  onBubbleText(text) {
    const cfg = this.cfg;
    if (cfg.enabled !== true) return;
    const maxChars = clampInt(cfg.maxChars, 40, 500, 220);
    const line = text.length > maxChars ? `${text.slice(0, maxChars - 1)}\u2026` : text;
    if (line.length < clampInt(cfg.minChars, 0, 20, 1)) return;
    const verdict = this.speaker?.say(line);
    if (cfg.verbose === true) {
      this.logAt('info', verdict === 'queued' ? `朗读排队：${line}` : `朗读未排队（${verdict}）：${line}`);
    }
  }

  onSpeakerEvent(e) {
    const cfg = this.cfg;
    if (e.kind === 'spoken') {
      this.lastSpokenAt = Date.now();
      this.lastSpokenText = e.text;
      if (cfg.verbose === true) {
        const via = e.engine === 'local'
          ? `本地 ${e.model ?? ''}${e.audioMs ? ` ${Math.round(e.audioMs / 100) / 10}s` : ''}${e.firstAudioMs != null ? `（首音 ${e.firstAudioMs}ms）` : ''}`
          : ['minimax', 'breeze'].includes(e.engine)
            ? `云端 ${e.model ?? ''}${e.audioMs ? ` ${Math.round(e.audioMs / 100) / 10}s` : ''}`
            : (e.fellBack ? `系统语音（引擎失败：${e.cloudError ?? ''}）` : '系统语音');
        this.logAt('info', `已念 [${via}]：${e.text}`);
      }
    } else if (e.kind === 'failed') {
      this.lastError = e.error ?? '';
      this.logAt('warn', `朗读失败（${e.engine ?? '?'}）：${this.lastError}｜原句：${e.text}`);
    } else if (e.kind === 'dropped') {
      if (cfg.verbose === true) this.logAt('info', `丢弃一句（${e.reason}）：${e.text}`);
    }
  }

  logAt(level, message) {
    try {
      this._log?.(level, message);
    } catch { /* 日志失败不该影响朗读 */ }
  }
}

/** 这个扩展对框架的声明。 */
const world = {
  id: WORLD_ID,
  label: 'BreezeBlue 气泡朗读',
  defaults,
  /** 控制台里的动态下拉（框架按 x-options 的 kind 调它）。 */
  configOptions: (kind, language = 'zh') => {
    if (kind === OPTION_KINDS.minimaxVoice) return minimaxVoiceOptions();
    // 本机音色库：定义上没有实例，自己去部署目录找服务地址
    if (kind === OPTION_KINDS.localVoice) return localVoiceOptionsFromDeployment(language);
    return [];
  },
  create: (ctx) => new PetVoiceWorld(ctx),
  // 自描述：不给工具、不推事件（旁听型 World，模型看不见）
  describe: { tools: [], events: [] },
};

export default world;
export { PetVoiceWorld, defaults as petVoiceDefaults };
