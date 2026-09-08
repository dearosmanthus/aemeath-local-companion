# 开发接手说明

本文件描述截至 2026-09-08 的源码状态。当前人物版本为 `game-toon-v4`。仓库提供应用代码和测试；新机器仍需自行配置运行环境并取得资产授权。资产准备见 [LOCAL-ASSETS.md](LOCAL-ASSETS.md)，贡献约定见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 先完成一次无资产接手

1. 克隆仓库，在项目根目录检查 `package.json`、配置模板和启动脚本。
2. 安装兼容的 Node.js 和依赖。开发需要 esbuild，因此使用 `npm ci`，不要只安装生产依赖。安装依赖可能访问包仓库；这一步不属于离线测试。
3. 依赖就绪后运行下方“离线检查”。没有角色、语音或大模型资产时，先运行 `test:avatar:core`，不要用真实对话替代测试。
4. 阅读本文件的性能限制，再按资产指南配置本地资源。不要从其他应用查找或复用凭据、聊天记录和声音。

本仓库不附带原角色模型、贴图、声音参考或其他音频、聊天历史、个人 `config.json`、运行缓存和日志、浏览器用户资料、Python 虚拟环境或模型权重。可发布的配置模板与个人配置是两回事；个人配置始终留在本机。

## 代码与运行结构

| 位置 | 职责 |
|---|---|
| `server.js` | HTTP / WebSocket 服务、语音识别接入、对话任务及取消、字幕、播放流和本机历史 |
| `lib/companion-network.js` | 本地组件的回环地址、请求来源、重定向及凭据限制 |
| `lib/local-services.js` | 本地模型、语音健康检查和流式 HTTP 协议 |
| `lib/conversation-channel.js` | 默认本地与用户主动选择的 API 通道；API 配置只保存在本次进程内存 |
| `lib/character-dialogue.js` | 角色提示与可朗读台词清理 |
| `lib/speech-prefetch.cjs` | 稳定首句的本地预合成、最终前缀校验、取消和余句衔接 |
| `voxcpm_voice_service.py` | 固定参考声音的本地 VoxCPM2 服务及已有合成缓存 |
| `voice_attention_patch.py` | 受版本和源码检查保护的 eager KV 缓存视图优化 |
| `wallpaper/vrm-avatar-entry.js` | 3D 舞台入口、模型加载、镜头、灯光、外观和帧循环 |
| `wallpaper/character-materials.mjs` | 按角色部位调校材质、脸部光照、透明叠层与隐藏组 |
| `wallpaper/character-shadows.mjs` | 仅基础前发 / 后发的局部阴影代理及生命周期 |
| `wallpaper/pmx-performance.js` | 精选面部形变、视线、肩臂手势及轻量发丝 / 飘带运动 |
| `wallpaper/wallpaper.js` | 麦克风、PCM / WAV 播放、缓冲、取消和实际播放驱动口型 |
| `wallpaper/avatar-view.mjs`、`wallpaper/render-performance.mjs` | 构图、像素预算、帧调度与压力降级 |
| `public/`、`wallpaper/stage-controls.js` | 控制界面、通道面板及舞台交互 |
| `scripts/` | 离线替身、真实授权 PMX 的本地测试及运行检查工具 |

默认本地端口：

| 端口 | 用途 |
|---|---|
| `127.0.0.1:17860` | 应用；舞台路径 `/stage/`，WebSocket 路径 `/ws` |
| `127.0.0.1:1235` | llama.cpp 的本地对话服务，兼容接口通常位于 `/v1` |
| `127.0.0.1:17861` | 本地 VoxCPM2 语音服务 |

本地通道失败不会自动切换到外部服务。可选 API 通道需要用户在本机面板中主动填写独立配置、确认发送范围并切换；默认不预设服务商，不读取其他应用的 Key。API 通道与“把本地接口地址改成外网地址”不同，不应混用。

## Windows 环境与资产适配

原开发环境为 Windows，使用 PowerShell / 批处理 / VBS 启动入口。推荐先在 Windows 上复现；仓库尚不承诺跨平台桌面启动。前端构建目标为 Chrome 110 及以上能力，实际依赖版本以锁文件为准。

语音路径经过验证的组合是 Python 3.12、VoxCPM 2.0.3、PyTorch 2.8.0+cu129 与 NVIDIA CUDA GPU。这个组合是已验证环境，不代表任意版本都等价兼容，也不是通用一键安装承诺。Python 环境尚无完整锁定的安装清单；依赖安装和 CUDA 兼容性需要接手者单独验证。

`server.js` 当前会一起初始化本地识别和 Kokoro 合成器；即使主要声音使用 VoxCPM，也需要以下识别、VAD 和备用合成文件才能完成应用的语音初始化。目录相对于本机 `speech.modelRoot`，资源须自行取得适用授权：

```text
speech.modelRoot/
  sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/
    model.int8.onnx
    tokens.txt
  silero_vad.onnx
  kokoro-multi-lang-v1_0/
    model.onnx
    voices.bin
    tokens.txt
    espeak-ng-data/
    lexicon-us-en.txt
    lexicon-zh.txt
```

Kokoro 子目录可通过 `speech.ttsModelDir` 配置。VoxCPM2 模型目录、授权参考音频和对应转写则分别通过 `LING_TTS_MODEL`、`LING_TTS_REFERENCE`、`LING_TTS_REFERENCE_TEXT` 指定；它们与前端试听文件独立。参考转写必须与本人获准使用的音频对应，不沿用其他人的语料内容。

启动前逐项适配：

- 将 `config.example.json` 复制为本机 `config.json`，存在个人配置时不要覆盖。确认 `llm.mode` 为 `local`，监听与本地服务地址均为预期回环地址。
- 将 `speech.modelRoot` 等模型目录改为自己机器的目录，并核对所需文件齐全。
- 核对 `Start-Companion-Model.bat` 中的 `LLAMA_SERVER`、`MODEL`、端口和线程参数。当前模型配置使用 CPU 推理；不要因为机器有 GPU 就直接增加显卡层数，先评估语音与渲染的显存占用。
- 核对 `launch-natural-voice.vbs` 的 Python 路径和模型缓存目录。历史启动配置含 G 盘绝对路径；新机器没有相同盘符时必须适配。
- 核对 `voxcpm_voice_service.py` 的本地模型和授权参考路径。其 `LING_TTS_MODEL`、`LING_TTS_REFERENCE` 等环境配置只能指向本次项目明确选择的资源。不要为调试速度顺带更换声线、参考语料、CFG 或采样步数。
- 保留仅回环监听、来源校验和禁止重定向的限制；不要用关闭这些校验处理配置报错。

旧 `Download-Companion-Model.ps1` / `Finalize-Install.ps1` 的下载流程默认准备 4B，而当前 `Start-Companion-Model.bat` 默认指向 9B；它们尚未统一为新机器的一键安装器。不要只运行下载脚本就假定当前模型已齐全。启动脚本现在支持 `LLAMA_SERVER` 和 `MODEL` 环境变量覆盖，需自行核对可执行文件和实际模型路径。

配置和授权资源准备后，先执行 `node scripts/check-local-config.cjs`。随后可使用 `Start-Aemeath-Companion.bat` 启动桌面舞台，或使用 `Start-Desktop-Companion-Services.ps1` 启动服务。需要直接运行 `npm start` 时，也应先准备有效本机配置和所需服务。

启动器会核对应用运行标识；端口占用不代表该进程可以安全复用或结束。遗留 `Stop-Cyber-Girlfriend.ps1` 仍按端口强制结束进程，是待修项。接手时不要把它当作已经完成身份核验的停止入口；先核实进程确属自己启动的项目。

## 检查运行版本

无需发起对话即可读取以下本地状态。只记录需要的状态字段，不导出整份配置、历史或日志。

- 应用 `/api/runtime`：对话策略应为 `selectable-chat-v1`，本地传输为 `loopback-only-v2`，首句管线为 `local-first-sentence-prefetch-v1`。
- 语音 `/health`：先看 `ready`、引擎和设备，再看 `attentionOptimization.enabled` 与 `reason`。
- 舞台：当前人物标记应为 `game-toon-v4`；浏览器可检查 `window.AemeathAvatar.inspect()` 的状态与指标。

首句预合成及 KV 视图优化已经在原开发环境重启后的健康接口确认启用。新环境是否启用仍以实际状态为准；依赖版本或接口变化会使 KV 优化安全跳过，继续使用原实现。运行标记只用于兼容性检查，不是身份认证或性能证明。

## 当前人物表现

- 眼睛、脸、皮肤、头发、衣料、金属和发光饰件分别调校；保留资源本身的贴图内容。
- 当前运行时只保留 16 个顶点形变，不加载材质形变。透明度原本为零的 10 组不再提交主绘制，主画面为 34 组、128,299 面；原几何和资产文件没有被删除。
- 高光头发叠层保留透明度，关闭其深度写入，基础头发仍正常写入深度。
- 局部头发阴影为 512 像素、最多 10 Hz，只增加刷新帧的两组投影绘制。代理共享骨骼与顶点属性；经过验证无头发位移的面部形变不复制到第二份 GPU 形变纹理。
- “原始效果”或压力达到第二级时关闭附加阴影。原始档仍保留透明组跳过、发片深度等修复，不等于原游戏引擎的渲染。
- 动作采用轻量骨骼驱动；尚未完成成套游戏关键帧、手部 IK、完整衣裙碰撞或模型拓扑重建。

修改 `wallpaper/` 的入口及其导入模块后执行 `npm run build:avatar`，再刷新舞台。语音或服务端代码的生效需要对应服务正常重启；构建前端不能替代后台重启。修改 Three.js 版本后必须重新检查材质着色器、阴影回调顺序及资源释放。

## 已知性能边界与接下来要做的事

目前没有证据表明整机卡顿已经解决，也没有测出完整语音链路加速：

| 项目 | 已知结果及限制 |
|---|---|
| 本地对话 | 现有 9B 配置使用 CPU；短时非隐私基准约 5.68 token/s。实际提示和上下文可能进一步增加等待 |
| 完整语音 | 相同固定句、同 seed、排除旧缓存后，3.52 秒音频的一次耗时由 10.849 秒变为 13.979 秒；后者实时因子约 3.971，仍慢于实时 |
| 测量条件 | 前后冷启动、温度与并行 GPU 负载未控制，不能把差异单独归因 KV 补丁，也不能把小型算子测试当成完整 TTS 提速 |
| 画面 | 曾短时测得约 60 FPS，后续重载下也出现约 8–13 FPS；浏览器提交耗时不等于 GPU 完成耗时 |
| 缓冲与首句 | PCM 预缓冲和首句预合成可改善到达抖动或重叠等待，但不能持续弥补慢于实时的语音生成 |

下一步优先做可归因的配对测试：固定文本、seed、声线、采样步数和预热状态，排除旧合成缓存，记录并行负载，再分别测对话、合成、播放与渲染。缓存键不包含 KV 补丁状态；直接重复旧句可能命中旧音频，不能据此宣称提速。需要保留基准缓存时只处理已核验的单条测试文件，不批量清空用户缓存。

完整麦克风整轮对话、音频断续和听感一致性仍需另行授权后验收。后续动作与资产工作应优先解决可见变形和姿态问题，不能用单纯增面替代蒙皮、动画和光照。

## 离线检查

依赖安装完成后，以下 npm 测试默认使用本地源码、合成数据或内存替身；不会调用真实模型服务或外部 API。

| 命令 | 是否需要授权资产 |
|---|---|
| `npm run check` | 不需要；JavaScript 语法检查 |
| `npm run test:local` | 不需要；本地访问限制与客户端协议替身 |
| `npm run test:channel` | 不需要；本地 / API 选择、取消和隔离替身 |
| `npm run test:dialogue` | 不需要；台词与角色提示逻辑 |
| `npm run test:audio` | 不需要；PCM 调度、播放时序及首句管线替身 |
| `npm run test:avatar:core` | 不需要；镜头、预算及帧调度 |
| `npm run test:avatar:assets` | 需要；使用本机授权 PMX / 贴图检查表情、动作、材质及阴影 |
| `npm run test:avatar` | 需要；人物完整测试入口 |
| `npm run build:avatar` | 不需要角色资产；需要开发依赖 esbuild |

可选的 `scripts/test-voice-attention-patch.py` 使用已安装的项目 Python / Torch / VoxCPM 环境与合成张量，不载入真实 TTS 权重或参考音频。机器支持 CUDA 时它包含一次小型 GPU 比较，结果不代表完整语音合成。

不要对不熟悉的旧 `test-*` 脚本一键全部运行；先检查它是否访问真实服务、写入音频或触发推理。真实测试的通道、发送内容和用户授权要求见贡献约定。
