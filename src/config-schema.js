/**
 * 面板的字段表：每组一张折叠卡的标题、说明，以及每项的标题、类型、范围、下拉来源。
 *
 * 这里的形状还是 JSON Schema，因为 src/index.js 的 panelState() 直接照它生成控件描述，
 * 而且它本来就是按框架的配置契约写的。但**不再交给框架**：`webUi()` 不返回 config，
 * 所以「配置」页签不会出现，不会再有第二份表单跟面板抢同一个字段。
 *
 * 键是配置里的点分路径（worlds.breezeblue-tts.*），和 src/index.js 的 defaults() 一一对应；
 * 写回时 index.js 会把前缀去掉再交给 ctx.persist()。
 * 'x-hot': true 表示改完立刻生效（这个 World 每次用都现读 ctx.cfg，所以都是热改）。
 *
 * 音色下拉用 'x-options'：panelState() 按 kind 调 configOptions() 现取选项
 * （系统音色是扫本机得到，不是写死的）。
 *
 * 卡片里的分节用 'x-section'：同一张卡里再分出小标题，避免把「服务连接」和「进程启动」
 * 十几项平铺成一长串。
 *
 * 顺序是刻意的：基础 → 两个云端（相邻，方便对比取舍）→ 本地 → 系统语音 → 高级。
 */
import { MINIMAX_MODELS, CHINESE_VOICES, EMOTIONS, AUDIO_FORMATS } from './cloud.js';

/** World 自己的 id，也是配置段名（worlds.breezeblue-tts）。 */
export const WORLD_ID = 'breezeblue-tts';

const K = `worlds.${WORLD_ID}`;

/** 动态下拉的 kind 名，index.js 的 configOptions() 按它返回选项。 */
export const OPTION_KINDS = {
  systemVoice: 'breezeblue-tts-system-voice',
  minimaxVoice: 'breezeblue-tts-minimax-voice',
  localVoice: 'breezeblue-tts-local-voice',
};

/**
 * 本机服务类型。现在只有 breeze-tts；以后接别的本地服务时往这里加一项，
 * 面板的「服务类型」下拉就会多一条（连接参数暂共用一套，差异再按类型分字段）。
 */
export const LOCAL_KINDS = ['breeze-tts'];

/**
 * 按界面语言给配置组。这里只做中英两种文案，其余语言回退中文。
 *
 * 描述都写成一句话：它是控件下面的小字，长了会把一屏撑得很吵。
 */
export function petVoiceConfigGroups(language = 'zh') {
  const en = language === 'en';
  const t = (zh, eng) => (en ? eng : zh);

  return [
    {
      id: `world:${WORLD_ID}`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('气泡朗读', 'Bubble speech'),
        description: t(
          '桌宠每说一句就念出来。默认关。',
          'Reads pet bubbles aloud, falling back to the Windows voice. Off by default.',
        ),
        properties: {
          [`${K}.enabled`]: {
            type: 'boolean',
            title: t('开启朗读', 'Read bubbles aloud'),
            description: t('气泡里的文字会被念出来。', 'Every line shown in a bubble is spoken.'),
            'x-hot': true,
          },
          [`${K}.cloudProvider`]: {
            type: 'string', title: t('声音服务', 'Speech provider'),
            description: t('失败时自动改用系统语音。', 'Falls back to the system voice when it fails.'),
            enum: ['breeze', 'minimax', 'local'], 'x-hot': true,
          },
          [`${K}.fallback`]: {
            type: 'string',
            title: t('声音来源', 'Voice source'),
            description: t('auto＝所选引擎失败就换系统语音；sapi＝只用系统语音。', 'auto: fall back to the system voice. sapi: system voice only.'),
            enum: ['auto', 'sapi'],
            'x-hot': true,
          },
          [`${K}.readAsk`]: {
            type: 'boolean',
            title: t('也念提问气泡', 'Read question bubbles too'),
            description: t('pet_ask 的提问与选项也念。', 'Speak pet_ask questions and options.'),
            'x-hot': true,
          },
          [`${K}.minChars`]: {
            type: 'integer',
            title: t('最短朗读字数', 'Shortest line to read'),
            description: t('更短的句子不念。', 'Shorter lines are skipped.'),
            minimum: 0,
            maximum: 20,
            'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${WORLD_ID}:breeze`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('BreezeBlue 云端语音', 'BreezeBlue cloud speech'),
        description: t(
          '密钥放部署目录 .env：BREEZE_API_KEY=…',
          'Put BREEZE_API_KEY=… in the deployment .env.',
        ),
        properties: {
          [`${K}.breezeEnabled`]: {
            type: 'boolean', title: t('启用 BreezeBlue', 'Enable BreezeBlue'),
            description: t('关掉＝不使用这个引擎。', 'Off means this engine is never used.'),
            'x-hot': true,
          },
          [`${K}.breezeVoice`]: {
            type: 'string', title: t('音色 ID', 'Voice ID'),
            description: t('形如 voc_…；不能填 MiniMax 的音色。', 'Usually voc_…; MiniMax voice IDs do not work.'), 'x-hot': true,
          },
          [`${K}.breezeModel`]: {
            type: 'string', title: t('模型', 'Model'),
            description: t('默认 breeze-tts-2。', 'Defaults to breeze-tts-2.'), 'x-hot': true,
          },
          [`${K}.breezeLanguageCode`]: {
            type: 'string', title: t('语言代码', 'Language code'),
            description: t('留空自动识别。', 'Empty detects it automatically.'), 'x-hot': true,
          },
          [`${K}.breezeInstructions`]: {
            type: 'string', title: t('演绎指令', 'Instructions'),
            description: t('描述语气，例如：温柔自然，像在聊天。', 'Describe the tone, e.g. warm and conversational.'), 'x-hot': true,
          },
          [`${K}.breezeSpeed`]: {
            type: 'number', title: t('语速', 'Speed'), minimum: 0.5, maximum: 2, multipleOf: 0.05, 'x-hot': true,
          },
          [`${K}.breezeVolume`]: {
            type: 'number', title: t('音量', 'Volume'), minimum: 0.01, maximum: 2, multipleOf: 0.01, 'x-hot': true,
          },
          [`${K}.breezeGuidanceScale`]: {
            type: 'number', title: t('演绎指令强度', 'Guidance scale'), minimum: 1, maximum: 10, multipleOf: 0.1, 'x-hot': true,
          },
          [`${K}.breezeSpeakerBoost`]: {
            type: 'boolean', title: t('增强音色相似度', 'Speaker boost'),
            description: t('填了演绎指令且强度大于 1 时服务端会忽略它。', 'Ignored when instructions are set with a guidance scale above 1.'), 'x-hot': true,
          },
          [`${K}.breezeTimeoutMs`]: {
            type: 'integer', title: t('云端超时', 'Cloud timeout'), minimum: 2000, maximum: 120000, 'x-suffix': 'ms', 'x-hot': true,
          },
          [`${K}.breezeApiKeyEnv`]: {
            type: 'string', title: t('密钥变量名', 'Key variable name'),
            description: t('一般留空。这里只填变量名 BREEZE_API_KEY，不是密钥本身。', 'Leave empty. A variable name, never the key itself.'), 'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${WORLD_ID}:minimax`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('MiniMax 云端语音', 'MiniMax cloud speech'),
        description: t(
          '密钥放部署目录 .env：MINIMAX_API_KEY=…',
          'Put MINIMAX_API_KEY=… in the deployment .env.',
        ),
        properties: {
          [`${K}.minimaxEnabled`]: {
            type: 'boolean',
            title: t('启用 MiniMax', 'Enable MiniMax'),
            description: t('关掉＝不使用这个引擎。', 'Off means this engine is never used.'),
            'x-hot': true,
          },
          [`${K}.minimaxVoice`]: {
            type: 'string',
            title: t('音色', 'Voice'),
            description: t('官方音色 ID；自己复刻的也能直接填。', 'A system voice ID; cloned voice IDs work too.'),
            'x-options': OPTION_KINDS.minimaxVoice,
            'x-hot': true,
          },
          [`${K}.minimaxModel`]: {
            type: 'string',
            title: t('模型', 'Model'),
            description: t('turbo 更快，hd 音质更好。', 'Turbo is faster, hd sounds better.'),
            enum: [...MINIMAX_MODELS], 'x-hot': true,
          },
          [`${K}.minimaxEndpoint`]: {
            type: 'string',
            title: t('接口站点', 'API site'),
            description: t('key 要和站点是同一家的。', 'The key must belong to the site you pick.'),
            enum: ['cn', 'io'], 'x-hot': true,
          },
          [`${K}.minimaxSpeed`]: {
            type: 'number', title: t('语速', 'Speed'), minimum: 0.5, maximum: 2, multipleOf: 0.05, 'x-hot': true,
          },
          [`${K}.minimaxVolume`]: {
            type: 'number', title: t('音量', 'Volume'), minimum: 0.1, maximum: 10, multipleOf: 0.1, 'x-hot': true,
          },
          [`${K}.minimaxPitch`]: {
            type: 'integer', title: t('音调', 'Pitch'), minimum: -12, maximum: 12, 'x-hot': true,
          },
          [`${K}.minimaxEmotion`]: {
            type: 'string',
            title: t('情绪', 'Emotion'),
            description: t('留空＝按文本自动决定。', 'Empty lets the model decide.'),
            enum: [...EMOTIONS], 'x-hot': true,
          },
          [`${K}.minimaxLanguageBoost`]: {
            type: 'string',
            title: t('语言倾向', 'Language boost'),
            description: t('中英混排时可选 Chinese。', 'Pick Chinese when the text mixes languages.'),
            enum: ['auto', 'Chinese', 'English', 'Chinese,Yue', 'Japanese', 'Korean'], 'x-hot': true,
          },
          [`${K}.minimaxSampleRate`]: {
            type: 'string', title: t('采样率', 'Sample rate'), enum: ['16000', '22050', '24000', '32000', '44100'], 'x-hot': true,
          },
          [`${K}.minimaxFormat`]: {
            type: 'string',
            title: t('音频格式', 'Audio format'),
            description: t('保持 wav，换格式可能没声音。', 'Keep wav; another format may stay silent.'),
            enum: [...AUDIO_FORMATS], 'x-hot': true,
          },
          [`${K}.minimaxTimeoutMs`]: {
            type: 'integer', title: t('云端超时', 'Cloud timeout'), minimum: 2000, maximum: 120000, 'x-suffix': 'ms', 'x-hot': true,
          },
          [`${K}.minimaxApiKeyEnv`]: {
            type: 'string', title: t('密钥变量名', 'Key variable name'),
            description: t('留空＝依次找 MINIMAX_API_KEY 等。', 'Empty tries MINIMAX_API_KEY and friends.'),
            'x-hot': true,
          },
        },
      },
    },
    {
      // 连接与进程放在同一张卡里：它们说的是同一件事（本机那个语音服务），
      // 分成两张卡会让人以为要各配一遍。进程那段用 'x-section' 分小标题隔开。
      id: `world:${WORLD_ID}:local`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('本地语音服务', 'Local speech service'),
        description: t(
          '交给本机的语音服务：不要密钥、不联网。服务和模型都在这一块配。',
          'Speech comes from a server on this machine: no key, nothing leaves the box.',
        ),
        properties: {
          [`${K}.localKind`]: {
            type: 'string',
            title: t('服务类型', 'Service type'),
            description: t('目前支持 breeze-tts，以后接别的本地服务会多出新选项。', 'breeze-tts for now; other local services will show up here.'),
            enum: [...LOCAL_KINDS],
            'x-hot': true,
          },
          [`${K}.localEnabled`]: {
            type: 'boolean', title: t('启用本地服务', 'Enable local service'),
            description: t('关掉＝不向本机发请求。', 'Off means no requests to 127.0.0.1.'),
            'x-hot': true,
          },
          [`${K}.localBaseUrl`]: {
            type: 'string', title: t('服务地址', 'Service URL'),
            description: t('留空＝http://127.0.0.1:8137。', 'Empty means http://127.0.0.1:8137.'),
            'x-hot': true,
          },
          [`${K}.localVoice`]: {
            type: 'string', title: t('音色 ID', 'Voice ID'),
            description: t('选项来自本机音色库；留空＝按演绎指令现场设计。', 'From the local voice library; empty designs a voice from the instruction.'),
            'x-options': OPTION_KINDS.localVoice,
            'x-hot': true,
          },
          [`${K}.localInstruction`]: {
            type: 'string', title: t('演绎指令', 'Instruction'),
            description: t('描述声音或语气，留空用服务默认。', 'Describe the voice; empty uses the server default.'),
            'x-hot': true,
          },
          [`${K}.localCfgScale`]: {
            type: 'number', title: t('演绎指令强度', 'CFG scale'),
            description: t('越大越贴指令，超过 3 声音发紧。', 'Higher follows the instruction harder; past 3 it turns harsh.'),
            minimum: 1, maximum: 10, multipleOf: 0.5, 'x-hot': true,
          },
          [`${K}.localSeed`]: {
            type: 'integer', title: t('随机种子', 'Seed'),
            description: t('同种子同文本＝同一段声音。', 'Same seed and text give the same audio.'),
            minimum: 0, maximum: 2147483647, 'x-hot': true,
          },
          [`${K}.localTimeoutMs`]: {
            type: 'integer', title: t('合成超时', 'Timeout'),
            description: t('本机较慢，默认 60 秒。', 'Local generation is slow; 60 s by default.'),
            minimum: 3000, maximum: 300000, 'x-suffix': 'ms', 'x-hot': true,
          },
          [`${K}.localServiceExe`]: {
            type: 'string', title: t('可执行文件', 'Executable'),
            description: t('留空＝上次成功的那个，或环境变量 BREEZE_SERVER_EXE。', 'Empty reuses the last one that worked, or BREEZE_SERVER_EXE.'),
            'x-path': { kind: 'file', extensions: ['.exe', '.bat', '.cmd'] },
            'x-section': t('进程（由扩展起停）', 'Process (started by the extension)'),
            'x-hot': true,
          },
          [`${K}.localServiceModel`]: {
            type: 'string', title: t('模型文件', 'Model file'),
            description: t('留空＝在 exe 旁边找 .gguf。', 'Empty takes a .gguf next to the exe.'),
            'x-path': { kind: 'file', extensions: ['.gguf'] },
            'x-hot': true,
          },
          [`${K}.localServiceArgs`]: {
            type: 'string', title: t('额外参数', 'Extra arguments'),
            description: t('例如 --chunk-max 40；--host/--port 由服务地址算。', 'e.g. --chunk-max 40; --host/--port come from the URL.'),
            'x-hot': true,
          },
          [`${K}.localServiceVoicesDir`]: {
            type: 'string', title: t('音色目录', 'Voices directory'),
            description: t('留空＝模型旁边的 voices。', 'Empty means voices/ beside the model.'),
            'x-path': { kind: 'directory' },
            'x-hot': true,
          },
          [`${K}.localAutoStart`]: {
            type: 'boolean', title: t('随 World 自动启动', 'Start with the World'),
            description: t('打开后，声音服务选「本地」时随 World 激活起一个；已在跑就不动。', 'When the provider is local, activating the World starts it if it is down.'),
            'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${WORLD_ID}:sapi`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('系统语音（回退）', 'System voice (fallback)'),
        description: t('引擎失败或没配密钥时用它。', 'Used when the engine fails or has no key.'),
        properties: {
          [`${K}.sapiVoice`]: {
            type: 'string',
            title: t('系统音色', 'System voice'),
            description: t('留空＝第一个可用音色。', 'Empty uses the first available voice.'),
            'x-options': OPTION_KINDS.systemVoice,
            'x-hot': true,
          },
          [`${K}.sapiRate`]: {
            type: 'integer', title: t('系统语速', 'System rate'),
            description: t('-10 最慢，10 最快。', '-10 slowest, 10 fastest.'),
            minimum: -10, maximum: 10, 'x-hot': true,
          },
          [`${K}.sapiVolume`]: {
            type: 'integer', title: t('系统音量', 'System volume'),
            minimum: 0, maximum: 100, 'x-suffix': '%', 'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${WORLD_ID}:advanced`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: t('朗读：高级', 'Bubble speech: advanced'),
        description: t('一般不用改。', 'Usually nothing to change.'),
        properties: {
          [`${K}.dataDir`]: {
            type: 'string', title: t('事件目录', 'Data directory'),
            description: t('读 events.jsonl 的地方，.env 也在这一层。', 'Where events.jsonl and the .env live.'),
            'x-path': { kind: 'directory' },
            'x-hot': false,
          },
          [`${K}.replayExisting`]: {
            type: 'boolean', title: t('启动时补念已有事件', 'Replay existing lines'),
            description: t('默认只念启动之后的新气泡。', 'By default only new bubbles are spoken.'),
            'x-hot': false,
          },
          [`${K}.maxChars`]: {
            type: 'integer', title: t('单句字数上限', 'Characters per line'),
            description: t('超长句子截断后再念。', 'Longer lines are cut before being spoken.'),
            minimum: 40, maximum: 500, 'x-hot': true,
          },
          [`${K}.playTimeoutSec`]: {
            type: 'integer', title: t('单句播放上限', 'Playback cap'),
            description: t('防止某个音频卡住队列。', 'So one bad file cannot stall the queue.'),
            minimum: 3, maximum: 600, 'x-suffix': 's', 'x-hot': true,
          },
          [`${K}.verbose`]: {
            type: 'boolean', title: t('写详细日志', 'Verbose logging'),
            description: t('每次朗读、回退、失败都写进日志。', 'Log every line, fallback and failure.'),
            'x-hot': true,
          },
        },
      },
    },
  ];
}
