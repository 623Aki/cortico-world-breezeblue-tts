# 来源与许可

上游作者：星云（[chenhongyuan1/cortico-world-breezeblue-tts](https://github.com/chenhongyuan1/cortico-world-breezeblue-tts)）。
本仓库由 623Aki 维护（[623Aki/cortico-world-breezeblue-tts](https://github.com/623Aki/cortico-world-breezeblue-tts)），基于上游 0.1.2。

本扩展派生自 `cortico-world-pet-voice@0.2.1`，原作者：杠精大队委。
原包在 npm 元数据中声明 MIT 许可；本派生版沿用 MIT，并保留原作者署名。
原包地址：https://www.npmjs.com/package/cortico-world-pet-voice

上游新增和修改：BreezeBlue 请求适配、独立 World ID、配置表单、凭据隔离与诊断脱敏、回退路由、离线测试和发布文档。

本仓库（623Aki）在 0.1.2 之上追加：本机 breeze-tts 服务的对接与音色库缓存（`src/local.js`、`src/voice-library.js`）、PCM 流式播放（`src/audio-host.js`、`scripts/pcm-sink.ps1`）、在扩展内起停本机服务的进程托管（`src/service.js`）、取代自动生成配置页的折叠式设置面板（`src/webui/`），以及配套测试。

`icon.svg` 是本派生版新建的几何语音气泡图标，使用本包 MIT 许可。原包的 `icon.png` 未随本包分发。
包内不含第三方图片、音频样本、声音模型权重或实际用户数据。

BreezeBlue、MiniMax 和 Coopanion 为各自权利人的名称。本扩展是独立适配，不代表这些服务的官方发布。
