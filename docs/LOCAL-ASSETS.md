# 本机角色资源与源码交接

GitHub 交接包提供程序源码，不包含当前角色模型、贴图、精灵图或声音素材。拿到源码后，可以先构建前端和运行无资源测试；还原本机角色效果需要接手者自行取得适用授权并安装资源。

## 当前角色许可

当前爱弥斯 PMX 署名为「鸣潮 / 1010浣」。原包的 `使用说明 read me (CN, JP, EN).txt` 明确禁止二次配布，并说明模型不论改造与否都不得再分发。项目记录的补充许可仍限定个人、本地、非商业、不上传和不对外分享，见 [角色导入说明](aemeath-avatar-import.md)。

因此，当前资源不随公开或私有 GitHub 仓库交接，也不放在 Release、Git LFS、CI 附件或模型派生测试 fixture 中。私有仓库不扩大原资源授权范围。接手者应自行从作者允许的渠道取得授权及对应资源；本机安装也须符合本人获得的许可。请保留原作者说明与署名，不从本项目历史或其他人的本机副本转存资源。

旧 GLB、角色精灵、头像和试听音频没有在本项目中附带可再分发许可，交接包同样不包含这些二进制文件。源码中的名称、路径和角色适配逻辑不代表这些资源已获转授权。

## 本机文件布局

路径均相对于项目根目录。不要提交这些本机资源。

| 用途 | 本机路径 | 说明 |
| --- | --- | --- |
| 当前 PMX 主模型 | `wallpaper/assets/models/aemeath-pmx/aemeath.pmx` | 当前适配与真实资源测试针对爱弥斯 1.05；自行取得适用授权后安装。 |
| PMX 贴图 | `wallpaper/assets/models/aemeath-pmx/tex/` | 保留完整原包目录和原始文件名，包括中文及空格。 |
| PMX 补充贴图 | `wallpaper/assets/models/aemeath-pmx/AONMPB/` | 与对应模型版本配套保留，不合并到 `tex/`。 |
| 原作者说明 | `wallpaper/assets/models/aemeath-pmx/使用说明 read me (CN, JP, EN).txt` | 保留所取得资源包的许可原文。 |
| 可选 VRM 后备模型 | `wallpaper/assets/models/aemeath.vrm` | 由接手者提供自己获准使用的 VRM；PMX 失败时会尝试加载。 |
| 可选 GLB 测试模型 | `wallpaper/assets/models/aemeath.glb` | 仅在 `/stage/?avatar=glb` 时选用；不保证角色专用口型和表情适配。 |
| 可选精灵后备形象 | `wallpaper/assets/pet/aemeath-spritesheet.webp` | 页面直接使用此文件名；`/stage/?avatar=pet` 使用精灵。须自行提供适用资源。 |
| 可选本地试听 | `wallpaper/assets/audio/aemeath-welcome.wav` | 「听她说一句」读取此文件；使用自己获准使用的声音，缺失时试听不能播放。 |
| 可选静态头像与预览 | `wallpaper/portrait-aemeath.png`、`wallpaper/portrait-yujie-v2.png`、`wallpaper/portrait.png` | 由接手者提供适用图片；Lively 预览引用 `portrait-aemeath.png`。 |

如果取得的原 PMX 文件使用中文名称，可以在本人许可范围内为本机入口保留一个名为 `aemeath.pmx` 的副本；贴图目录保持原样。不要只复制 PMX 而遗漏贴图。其他型号或版本可另行适配，但不能据此期待爱弥斯 1.05 的骨骼、材质数量和蒙皮断言通过。

模型、VRM 与精灵全部缺失时，页面不能展示原角色；不应把无角色的页面当作视觉验收通过。试听路径只用于前端本机演示，不是语音克隆服务的参考语料安装说明；语音模型和运行时配置请按交接文档另行配置。

## 测试入口

安装依赖后先运行不需要角色、贴图、声音或外部服务的核心测试：

```powershell
npm ci
npm run build:avatar
npm run test:avatar:core
```

`test:avatar:core` 检查镜头、视图设置、渲染预算、真实帧率统计、自适应迟滞及多刷新率帧调度。它不验证真实角色的蒙皮或视觉效果。

在本机安装获得授权的完整 PMX 包后运行：

```powershell
npm run test:avatar:assets
```

此入口先检查 `aemeath.pmx`、`tex/` 和 `AONMPB/`，再依次运行真实骨骼动作、材质和阴影测试。缺资源会打印本机安装指引并以非零状态退出，不会静默跳过；有资源后发生的测试失败也会原样传播。测试不会下载资源、启动语音服务、调用模型、打开麦克风或写入聊天历史。

原有 `npm run test:avatar` 保留原来的全部五项测试及顺序，供已经安装完整资源的本机开发流程继续使用。GitHub 上没有授权角色资源的 CI 应运行 `test:avatar:core`；真实资源测试和浏览器视觉验收在具备适用资源的开发者本机执行。
