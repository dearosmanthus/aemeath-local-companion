# 爱弥斯 · 本地赛博伴侣

面向 Windows 的本地语音伴侣开发项目。主程序为 Node.js，舞台使用 Three.js / PMX 骨骼表演，本地对话由 llama.cpp 提供，流式声音由 VoxCPM2 提供。可选 API 对话通道需要在本机界面手动配置，默认使用本地服务。

**接手先读 [TAKEOVER](docs/TAKEOVER.md)、[本机资源导入](docs/LOCAL-ASSETS.md) 和 [协作与审阅流程](CONTRIBUTING.md)。** 仓库提供可构建的源码、测试和文档；不包含个人数据、推理权重、语音参考或禁止二次分发的角色包。克隆源码不会自动得到原角色和声线。

## 当前版本

- 人物 `game-toon-v4`：按部位材质、头部局部刘海阴影、21 段头发 / 4 段飘带二次运动、16 个精选形变、自适应渲染和实际播放驱动口型。
- 本地首句预合成 `local-first-sentence-prefetch-v1`：与后续文本生成重叠等待；前端保留真实 PCM 缓冲与断流恢复。
- VoxCPM eager KV 视图补丁：严格检查兼容版本后启用，未更换权重、参考音频或 10 步采样。
- 性能尚未完全解决。9B CPU 短基准约 5.68 tokens/s；一次无缓存语音复测用 13.979 秒生成 3.52 秒音频。人物待机曾测得 60.4 FPS，后续高负载采样仍出现约 8–13 FPS。各次负载与温度未控制，不能据此宣称稳定帧率或语音提速。

详细记录：[人物升级](docs/game-look-upgrade-2026-09-08.md)、[性能实现](docs/performance-upgrade-2026-09-08.md)、[语音复测](docs/voice-benchmark-2026-09-08.md)。历史文档反映不同阶段，当前接手状态以 TAKEOVER 为准。

## 从干净源码开始

当前维护环境使用 Node.js 24。在仓库根目录运行：

```powershell
npm ci
npm run build:avatar
npm run check
npm run test:local
npm run test:channel
npm run test:dialogue
npm run test:audio
npm run test:avatar:core
```

这些检查使用内存替身或本地计算，不发起真实 AI 对话。依赖安装需要访问 npm；语音模型、Python 环境与第三方人物资产另行准备。GitHub Actions 只执行上述源码检查，不需要密钥、麦克风或 GPU。

开始完整运行前：

1. 按 [资源说明](docs/LOCAL-ASSETS.md) 自行取得授权，导入角色和可选试听资源。
2. 若还没有本机配置，复制 `config.example.json` 为 `config.json`；保留已有配置。示例中的 G 盘目录是待适配的默认路径。
3. 安装 llama.cpp，并准备与启动脚本一致的本地模型。`Start-Companion-Model.bat` 支持 `LLAMA_SERVER` 和 `MODEL` 环境变量覆盖路径。旧下载脚本的 4B 默认与当前 9B 运行配置不同，详见 TAKEOVER。
4. 准备识别、VAD、VoxCPM2 模型及 Python 环境；参考音频必须配套准确转写。当前启动器中的 G 盘路径需要按机器调整，仓库不提供推理权重或自动安装的完整 Python 锁文件。
5. 启动本机模型与语音服务后运行 `npm start`，或检查好上述路径后使用 `Start-Aemeath-Companion.bat`。

本机舞台：[http://127.0.0.1:17860/stage/](http://127.0.0.1:17860/stage/)。完整部署和已知启动器问题见 TAKEOVER；不要直接运行旧关闭脚本去终止未知端口进程。

安装合法的本机角色包后，可运行 `npm run test:avatar:assets`。原 `npm run test:avatar` 保持兼容，仍需要角色资源。不能用缺资源导致的测试跳过代替人物验收。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| `server.js` | 对话状态、流式音频、字幕、本机历史 |
| `lib/` | 本地协议、可选 API 通道、角色台词、首句预合成 |
| `voxcpm_voice_service.py` / `voice_attention_patch.py` | 本地声音服务与受保护的 KV 优化 |
| `wallpaper/vrm-avatar-entry.js` | 人物加载、灯光、镜头、渲染调度 |
| `wallpaper/character-materials.mjs` / `character-shadows.mjs` | 角色专用着色及局部阴影 |
| `wallpaper/pmx-performance.js` | 骨骼、眼神、表情、手势与二次运动 |
| `wallpaper/wallpaper.js` | 麦克风、PCM 播放、口型驱动 |
| `public/` | 传统界面与共享通道面板 |
| `scripts/` | 离线测试、资源检查与显式本机验收 |

根目录 `test-ws.js`、`test-vad-ws.js` 和 `test_voxcpm2.py` 属于人工执行的真实服务测试，不在 CI 中。它们可能生成语音、调用当前通道或写入历史。`scripts/acceptance-local.cjs --chat` 也会实际生成一轮本地对话，必须与纯离线检查区分。

## 数据与协作

`config.json`、`data/`、浏览器配置、密钥、聊天、缓存、声音和模型资源均被 Git 忽略。API Key 只通过本机界面配置，存于当前后台内存，重启清空。技术说明见 [对话通道](docs/conversation-channels.md)。

接手开发在独立分支完成，并提交 PR；维护者审阅改动、运行相关测试、查看人物/性能证据后再合并到 `main`。本仓库不启用自动合并，不把 CI 成功等同于游戏观感或真实语音已验收。

原角色属于“鸣潮 / 1010浣”的二创资源，现有包禁止二次分发。本仓库不授予第三方模型、贴图、声音或图像的分享许可，私有仓库也不应提交这些本机资源。
