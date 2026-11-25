# BreezeBlue 气泡朗读

Coopanion 气泡朗读：BreezeBlue、MiniMax 云端，或本机 breeze-tts-2 服务（不需要密钥）。设置面板按大标题折叠，可直接测试连接、起停本机服务；支持演绎控制和 Windows 系统语音回退。

包名为 `cortico-world-breezeblue-tts`，默认关闭。适用 Windows；需要 Coopanion 支持 World API 6。

作者与维护者：**星云** · [npm 安装包](https://www.npmjs.com/package/cortico-world-breezeblue-tts) · [反馈问题](https://github.com/chenhongyuan1/cortico-world-breezeblue-tts/issues) · [MIT 许可](LICENSE)

## 与 Coopanion 的关系

本项目是 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的第三方 World 扩展。Coopanion 是由 Pal-AI-Lab 开源的 AI 桌宠应用，负责对话、桌宠展示及扩展管理；本扩展为桌宠气泡提供语音朗读。

- **Coopanion 官方仓库**：[Pal-AI-Lab/Coopanion](https://github.com/Pal-AI-Lab/Coopanion)
- **Coopanion 中文说明**：[README_zh.md](https://github.com/Pal-AI-Lab/Coopanion/blob/main/README_zh.md)
- **Coopanion 安装包**：[官方 Releases](https://github.com/Pal-AI-Lab/Coopanion/releases/latest)
- **扩展市场索引**：[Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions)

连接流程：Coopanion 生成气泡 → 本扩展在本机读取 `desktop-pet.self` 事件 → 将朗读文字发送到所选服务（BreezeBlue / MiniMax API，或本机的 breeze-tts-2）→ 在 Windows 播放返回的 WAV；失败时自动切换系统语音。

请先安装并配置 Coopanion，再通过它的扩展页安装本包。Coopanion 本身支持多个系统；本扩展当前的音频播放和系统语音回退依赖 Windows。扩展按 World API 6 接入，已在 Coopanion 0.2.11 验证。

本项目由星云独立维护，保留上游代码来源与许可说明。Coopanion 官方项目以其自身许可证为准，本扩展采用 MIT 许可。

## 安装

在 Coopanion 扩展页搜索 `cortico-world-breezeblue-tts` 并安装，随后重启 Coopanion。
控制台 → World →「BreezeBlue 气泡朗读」，激活并开启朗读。

独立 World ID 为 `breezeblue-tts`，配置段为 `worlds.breezeblue-tts`。
若同时装有原 `cortico-world-pet-voice`，请只启用其中一个朗读扩展，避免同一句被朗读两次。

## BreezeBlue 配置

### 1. 获取 API Key

1. 打开 [BreezeBlue 平台首页](https://breezeblue.ai/app/home)，注册或登录账号。
2. 打开 [API Keys 管理页](https://breezeblue.ai/app/developer/api-keys)，点击 **Create API key**。
3. 为密钥填写一个便于识别的名称，例如 `Coopanion TTS`，创建后立即复制并保存完整 API Key。官方只在创建或轮换时显示完整密钥，之后无法再次查看。
4. 语音合成会消耗账户额度；如果设置了密钥预算，也需要确保该预算允许合成。额度和价格以平台当前页面为准。

操作依据：[官方快速开始](https://docs.breezeblue.ai/quickstart)、[API Key 与鉴权说明](https://docs.breezeblue.ai/authentication)。

### 2. 在 Coopanion 中使用密钥

1. 在当前部署目录（含 `config.json` 的目录）创建或编辑 `.env`，合并 `breeze.env.example` 中的变量：

   ```dotenv
   BREEZE_API_KEY=你的实际密钥
   ```

2. 声音服务选 `breeze`，启用 BreezeBlue，填写账户可访问的音色 ID，通常为 `voc_...`。
3. 模型默认 `breeze-tts-2`；语言留空自动识别，也可填 `zh` 或 `en`。

「密钥变量名」通常留空。它只接收 `BREEZE_API_KEY` 这样的名称；不要在该栏粘贴密钥本身。
`.env` 和表单参数每次朗读重新读取；新增或修改系统环境变量后通常需要重启 Coopanion。

### 3. 获取音色 ID

API Key 和音色 ID 分别填写：API Key 放入 `.env`，音色 ID 填入「朗读设置 → BreezeBlue 云端语音」的「BreezeBlue 音色 ID」。在包目录中查询账户可用音色，`--data` 指向你的部署目录：

```powershell
node scripts/breeze-probe.mjs --data "<部署目录>" --voices --language zh
```

从返回的列表中选择一个音色，将其 `id`（通常形如 `voc_...`）粘贴到面板里那一栏。去掉 `--language zh` 查所有语言。返回下一页标记时，使用 `--page-token` 传入 `nextPageToken`。

密钥和音色配置完成后，可运行离线状态检查：

```powershell
node scripts/breeze-probe.mjs --data "<部署目录>"
```

`configured: true` 表示已读到密钥，`ready: true` 表示密钥和音色 ID 均已填写；它们不代表已验证服务端授权，真实试听命令见下方「测试与诊断」。

## 设置面板

World 页的第一张卡是「朗读设置」，按大标题折成几张卡：**默认全部收起**，收起时标题右边写着这一块的当前状态（开/关、服务地址、音色），要改哪块再展开。

这里是这个 World **唯一的设置入口**：不再额外生成「配置」页签。一个字段只有一处可改，就不会出现「面板是空、配置页有值」或者改了一边另一边不动的事。

卡片按「基础 → 两个云端 → 本地 → 系统语音 → 高级」排：

| 卡片 | 放什么 |
|---|---|
| 气泡朗读 | 朗读开关、声音服务（`breeze` / `minimax` / `local`）、回退方式、最短字数 |
| BreezeBlue 云端语音 | 音色 ID、模型、语言、演绎指令、语速音量、超时 |
| MiniMax 云端语音 | 音色、模型、站点、语速音调情绪、采样率、超时 |
| 本地语音服务 | **一张卡里两段**：上半段是服务类型 / 地址 / 音色 / 演绎指令 / 超时，下半段「进程（由扩展起停）」是 exe、模型、参数、音色目录、随 World 自动启动 |
| 系统语音（回退） | 系统音色、语速、音量 |
| 朗读：高级 | 事件目录、单句字数上限、播放上限、详细日志 |

本地服务合并成一张卡，是因为「连哪个地址」和「起哪个进程」说的是同一件事；分成两张会让人以为要各配一遍。

顶部一行是状态与服务开关：

| 按钮 | 做什么 |
|---|---|
| 测试连接 | 本机服务：`/health` + 真合成一句「你好。」（不播放），回报采样率、音色数与合成耗时；云端：只检查 key 与音色是否齐（**不发起计费请求**） |
| 启动服务 | 用面板里配的 exe 与模型把 breeze-server 拉起来，等 `/health` 真的通了才算成功 |
| 停止服务 | 只结束**本扩展启动**的那个进程；手动开的服务只显示「别处启动的」，不会去抢着关 |
| 日志 | 看最近的进程输出（`<部署目录>/breeze-service.log`） |

启动是 `windowsHide` 的：不弹控制台，也不开浏览器（`--webui` 只是让服务顺带把自带网页挂在 `/`）。

**关掉 Coopanion 时服务会跟着停**，不留后台进程：正常退出时由关机流程停，退出得很突然则由退出钩子同步收尾。**在控制台「World」页把这个 World 停用（电源按钮）、或卸载扩展，也一样会停**——两者走的是同一个 `stop()`，2.5 秒后没有 `start()` 回来就停掉；这 2.5 秒内重新启用则会撤销，模型不用重载。单纯重启 World 不受影响：保留已经加载好的模型，省掉十几秒的重载。认领进程时会核对进程名，所以状态文件里的 pid 被系统复用给别的程序时不会被误认、也不会被误杀。

## 本地服务配置（breeze-tts-2.cpp）

本机跑 breeze-tts-2 时不需要密钥：扩展把文字发给 `http://127.0.0.1:8137/v1/audio/speech`（OpenAI 兼容的 JSON 请求，`response_format: "wav"`），拿回 WAV 直接播放。文字不出本机。

连接参数和进程参数都在同一张卡「本地语音服务」里：「服务类型」现在是 `breeze-tts`（以后接别的本地服务会多出新选项），下半段是进程（由扩展起停）。

1. 在「朗读设置 → 本地语音服务」的**进程**一段里选中可执行文件与模型（`.gguf`）；音色目录与额外参数可以不填，扩展会去 exe 旁边和上一级目录找 `*.gguf` 与 `voices/`；
2. 回到同一张卡，按顶部「启动服务」。等状态变成「运行中」并显示采样率就绪；
3. 把「声音服务」选成 `local`；
4. 「音色 ID」变成一个下拉框，选项来自服务的音色库（`GET /v1/voices`，保存的与缓存的都在内，例如 `ojou`、`tsun`，标签里带音色说明和参考音长度）。选「不用音色」则按「演绎指令」现场设计一个声音，没存过音色也能用；
5. 打开「开启朗读」。

也可以继续用外部脚本启动（`breeze-server breeze-tts-2-q4_k.gguf --host 127.0.0.1 --port 8137 --voices-dir voices`）：面板会认出「别处启动的」，朗读照常。

下拉是**读服务现况**的：面板打开时后台刷一次，缓存在部署目录的 `voice-library.json` 里，重启后不用等网络就有选项；服务没启动时只剩「不用音色」那一条，配置里已存的 ID 也仍然可用。服务里新增或删除音色后，重新打开一次下拉即可看到变化。音色库为空时请先在服务的 WebUI「VOICE LIBRARY」里存一段参考音。

服务默认只监听 `127.0.0.1`，没有鉴权、没有限速，不要直接暴露到公网。

## 参数

| 参数（`worlds.breezeblue-tts.*`） | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 朗读总开关 |
| `cloudProvider` | `breeze` | `breeze` / `minimax` / `local` |
| `fallback` | `auto` | `auto` 所选引擎优先；`sapi` 仅系统语音 |
| `breezeEnabled` | `true` | BreezeBlue 开关 |
| `breezeVoice` | 空 | 账户可访问的音色 ID |
| `breezeModel` | `breeze-tts-2` | 留空由服务端选模型 |
| `breezeLanguageCode` | 空 | 两字母代码，例如 `zh` / `en` |
| `breezeInstructions` | 空 | 与输入同语言的语气、情绪描述 |
| `breezeSpeed` | `1` | 0.5–2 |
| `breezeVolume` | `1` | 0.01–2 |
| `breezeGuidanceScale` | `1` | 1–10；演绎指令强度 |
| `breezeSpeakerBoost` | `false` | 增强音色相似度；有指令且强度 > 1 时由服务端忽略 |
| `breezeTimeoutMs` | `15000` | 包含合成与音频下载 |
| `breezeApiKeyEnv` | 空 | 自定义密钥变量名 |
| `localKind` | `breeze-tts` | 本地服务类型；目前只有 `breeze-tts`，以后接别的服务会多出选项 |
| `localEnabled` | `true` | 本地服务开关；关掉＝不向 127.0.0.1 发请求 |
| `localBaseUrl` | `http://127.0.0.1:8137` | 服务地址；服务换了端口这里也要改 |
| `localVoice` | 空 | 从服务的音色库里选；留空＝按演绎指令设计 |
| `localInstruction` | 空 | 与输入同语言的声音/语气描述；留空用服务默认 |
| `localCfgScale` | `1` | 1–10；演绎指令强度 |
| `localSeed` | `42` | 同一句同一个种子得到同一段声音 |
| `localTimeoutMs` | `60000` | 本机生成较慢，超时才回退 |
| `localServiceExe` | 空 | `breeze-server.exe` 路径；留空＝上次成功的那个，或环境变量 `BREEZE_SERVER_EXE` |
| `localServiceModel` | 空 | 要加载的 `.gguf`；留空＝exe 目录或上一级目录里的第一个 |
| `localServiceArgs` | `--chunk-max 40` | 额外参数；`--host` / `--port` 由服务地址算，不用写 |
| `localServiceVoicesDir` | 空 | 音色目录；留空＝模型旁边的 `voices/` |
| `localAutoStart` | `false` | World 启动时如果服务没在跑就自动拉起（仅当声音服务选 `local`） |
| `maxChars` | `220` | 单句字符上限，最多 500 |
| `verbose` | `false` | 本机详细日志，可能包含朗读文字 |

密钥查找：兼容明文配置 `breezeApiKey` → 自定义环境变量 → `BREEZE_API_KEY`、`BREEZEBLUE_API_KEY`、`BREEZE_BLUE_API_KEY` → 部署 `.env`。推荐使用 `.env`。

MiniMax 使用独立的 `MINIMAX_API_KEY`、`minimax*` 配置和音色 ID；在声音服务选择 `minimax` 后生效。两家密钥不会互相代用。本机服务不需要任何密钥。

## 与气泡的同步

气泡文字是 Coopanion 自己画的，扩展改不了它出现的时刻，能做的只有把"出声"这一侧压到最短。原来的链路有三处固定延迟，现在都处理了：

| 环节 | 原来 | 现在 |
|---|---|---|
| 读到气泡文字 | 500 ms 轮询 | 150 ms 轮询 |
| 合成到能出声 | 整句合成完才播（8 秒的句子要等 4.8 秒） | 边生成边播，**首音 250–350 ms** |
| 起播放进程 | 每句一个新 PowerShell，冷启动约 1.2 秒 | 常驻一个播放进程，只在挂载时启动一次 |

实测（本机 breeze-tts-2 / 24 kHz）：一句 2.2 秒的话，文字出现后约 0.3 秒开始出声，整句结束时间与音频长度对齐；长句不再等整段合成。

做法是向本机服务要 `response_format: "pcm"`（服务边生成边发），收到的每一块直接写进常驻播放进程的 waveOut 队列，`speak()` 等到播完才返回，所以队列仍然是一句接一句、不会叠音。云端两家（BreezeBlue / MiniMax）没有分块接口，仍是整段合成后播放，延迟与以前一样。

如果常驻进程起不来（没有 PowerShell、`Add-Type` 被策略挡住、没有可用音频设备），日志里会有一行说明，并自动退回原来的"整段 WAV + Media.SoundPlayer"播法，朗读不会因此不可用。

## 回退与限制

缺少密钥或音色、网络超时、接口失败、播放失败均回退 Windows 系统语音。连续失败三次后暂停所选引擎 120 秒，再尝试恢复。切换服务会清除旧引擎的熔断状态。

BreezeBlue 使用同步文字转语音接口，固定请求 WAV，由 Windows Media.SoundPlayer 播放。若服务端返回 202 后台任务，本句回退系统语音；此版不轮询后台任务、不支持流式播放或时间戳对齐。

本机服务一次只处理一个请求：朗读队列本来是一句一句来的，只有同时手动开着服务的 WebUI 生成时才会撞上 409，扩展会等一会儿重试（最多三次），仍忙才回退。本机服务走 PCM 流式播放，不再需要修补流式 WAV 的占位长度；只有退回整段播法时才会碰到那个问题（收到后按实际字节数补齐，否则 Media.SoundPlayer 会拒绝播放）。服务没有语速控制，`speed` 类参数对它无效；语速只能靠服务的参考音与 `--chunk-*` 参数调。

事件监听依赖 `desktop-pet.self` 事件格式；升级 Coopanion 后若格式变化，需要重新验证。此扩展不向模型提供工具。

## 测试与诊断

克隆开源仓库后运行离线测试，开发环境需安装 Node.js 20.19 或更高版本：

```powershell
git clone https://github.com/chenhongyuan1/cortico-world-breezeblue-tts.git
cd cortico-world-breezeblue-tts
npm test
```

扩展的运行代码没有额外 npm 依赖。以下诊断命令在仓库根目录执行，`--data` 指向你自己的 Coopanion 部署目录：

```powershell
# 离线自动测试，不发起真实合成
npm test

# 检查配置状态，不输出密钥
node scripts/breeze-probe.mjs --data "<部署目录>"

# 完整自检，包含本机语音及播放器探测
node scripts/selftest.mjs --data "<部署目录>"

# 真实生成并播放，会消耗少量合成额度
node scripts/breeze-probe.mjs --data "<部署目录>" --speak --play --text "你好。"

# 本机服务：进程在不在、采样率、音色数（不传 --data 就用包内默认值）
node scripts/local-probe.mjs

# 本机服务：列出音色
node scripts/local-probe.mjs --voices

# 本机服务：真实合成并播放，不产生费用
node scripts/local-probe.mjs --speak --play --voice ojou --text "你好。"
```

测试用假密钥均为离线固定样例。历史 `selftest.mjs --cloud` 和 `minimax-probe.mjs` 专门验证 MiniMax，BreezeBlue 使用 `breeze-probe.mjs`，本机服务使用 `local-probe.mjs`。

`npm test` 里跑的是：`test-local.mjs`（合成请求、超时、WAV 修补）、`test-voice-library.mjs`（音色下拉、缓存与降级）、`test-service.mjs`（起停服务的路径解析、参数拼接、等待就绪、只停自己起的那个）、`test-panel.mjs`（面板默认全折叠、控件渲染、改一项只提交那一项、按钮接上数据面）。

`test-panel.mjs` 需要在真 DOM 里跑一遍，jsdom 不是本包的依赖：有就自动用，没有就跳过。想跑全套就先指个路：

```powershell
$env:BBT_JSDOM = "<任意 node_modules>/jsdom"; node scripts/test-panel.mjs
```

## 数据与许可

开启云端朗读后，朗读文字会发送至所选语音服务；系统语音模式不发送云端请求；选本机服务时文字只在本机回环上传输，不经过任何外部端点。没有开发者遥测端点。详见 [PRIVACY.md](PRIVACY.md)。

本派生版作者与维护者：**星云**。MIT 许可，派生自杠精大队委的 `cortico-world-pet-voice@0.2.1`；保留原作者署名，来源及修改说明见 [NOTICE.md](NOTICE.md) 和 [LICENSE](LICENSE)。本包使用新建 SVG 图标，不分发原图标或任何音频样本。

接口参考：[BreezeBlue TTS](https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech)、[音色列表](https://docs.breezeblue.ai/api-reference/voices/list-voices)、[输出格式](https://docs.breezeblue.ai/concepts/output-format)。
