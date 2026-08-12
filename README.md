简体中文 | [English](README.en.md)

# CloseScreen

CloseScreen 是 Siddharth Vaddem 的 OpenScreen 的社区维护分支，后者是一款采用 MIT 许可的开源录屏与剪辑工具。本项目不是 OpenScreen 的官方延续或继任项目；它保留原项目的署名与许可，同时以独立分支的形式维护自己的产品标识、议题清单、CI 与发布流程。

## 署名

本项目基于 [Siddharth Vaddem 的 OpenScreen](https://github.com/siddharthvaddem/openscreen)。原项目采用 MIT 许可，原始 `LICENSE` 文件被有意保持不变。

## 项目状态

- 维护中的分支：持续维护；Windows 原生采集链向 Rust 的迁移已完成并设为默认，发布验证单独跟踪。
- 发布线：本分支独立版本化为 `v1.5.0-fork.*`，当前发布版本为 `v1.5.0-fork.4`。
- 产品标识：`CloseScreen`，包名 `closescreen`，appId `io.github.my-denia.closescreen`。
- 包管理：npm，配合 `package-lock.json`；Node 版本以 `.nvmrc` 为准。
- 分发：GitHub Actions 可为本分支的 GitHub Releases 构建未签名的 Windows 与 Linux 产物。外部包管理渠道未做自动化。
- 更新：应用会检查本分支的稳定 GitHub Releases，发现新版本时打开发布页面。它不会自动下载、自动安装、常驻更新服务，也不会把用户订阅到预发布通知。

## 本分支改动了什么

最主要的改动是 Windows 采集链：它已迁移到 Rust，并且现在是默认路径。

- `electron/native-bridge/windowsNativeHelpers.ts` 中的 `parseWindowsNativeBackend` 在
  `CLOSESCREEN_WINDOWS_CAPTURE_BACKEND` 未设置时返回 `rust`，因此未做任何配置的安装即走 Rust 的
  WGC/WASAPI/Media Foundation 采集助手。
- 旧版 C++ 助手仍随包提供，作为显式回退路径：启动 CloseScreen 前设置
  `CLOSESCREEN_WINDOWS_CAPTURE_BACKEND=legacy` 即可。该值必须恰为 `rust` 或 `legacy`；其他取值
  按配置错误处理，而不是静默回退，且录制开始后不会中途切换后端。
- 该切换落在提交 `71b991a`（本仓库的 PR #82），并首次随 `v1.5.0-fork.4` 公开发布。
- Rust 工作区在 `electron/native/rust/rust-toolchain.toml` 中固定工具链版本 `1.96.1`，并生成
  [RUST_THIRD_PARTY_NOTICES.md](./RUST_THIRD_PARTY_NOTICES.md)。

其余由本分支自行承担、而非承自上游的工作：

- 主进程中导出路径与 `read-binary-file` 的 IPC 收紧。
- 手动、先出计划再执行的录制清理，且只处理会话清单所引用的会话产物。
- 固定指向本分支自身仓库的更新检查，仅提供链接，不带更新服务。
- 校验标签与源码 SHA 的发布工作流，产出扁平资产集并附带 SHA-256 校验和。
- 一套文档：[支持矩阵](./docs/SUPPORT_MATRIX.md)、[隐私说明](./docs/PRIVACY.md)、
  [回归检查清单](./docs/REGRESSION_CHECKLIST.md)，以及
  [Windows 原生录制路线图](./docs/engineering/windows-native-recorder-roadmap.md)。

## 向上游提交的贡献

本分支维护者的下列工作已合入上游 OpenScreen 仓库。它们属于上游，不属于 CloseScreen 自身的功能集：

- <https://github.com/getopenscreen/openscreen/pull/73> —— WGC 采集助手中的软件 H.264 回退。
- <https://github.com/getopenscreen/openscreen/pull/152> —— Notes 提词器模式。
- <https://github.com/getopenscreen/openscreen/pull/228> —— 提词器只读问题修复。

CloseScreen 并不提供 Notes 或提词器功能，上述改动只存在于上游。本仓库的 PR 编号与上游编号互不相干，不应对照理解。

## 平台支持

简而言之：CloseScreen 目前从本社区分支发布未签名的 Windows 与 Linux 构建。macOS 不是本分支当前的发布目标。逐项功能状态与验证说明见完整的[支持矩阵](./docs/SUPPORT_MATRIX.md)。

| 平台 | 当前状态 | 采集路径 | 发布产物 |
| --- | --- | --- | --- |
| Windows 10 2004+ / Windows 11 x64 | 主要维护的桌面目标 | 默认使用 Rust 的 WGC/WASAPI/Media Foundation 后端；随包提供旧版 C++ 回退 | GitHub Releases 上的未签名 NSIS 安装包 |
| Linux | 社区支持 | 浏览器采集路径，检测到 Wayland 时启用 PipeWire 相关开关 | GitHub Releases 上的未签名 AppImage、deb 与 pacman 包 |
| macOS | 不是当前的发布目标 | 未针对本分支当前的发布流程做过验证 | 当前 electron-builder 配置与 GitHub 发布工作流中没有 macOS 产物 |

未签名构建可能触发操作系统警告。Windows 可能弹出 Microsoft Defender SmartScreen 或未知发布者提示；Linux 桌面可能需要为 AppImage 添加可执行权限，或信任本地安装的软件包。这些提示对未签名的社区构建属于预期现象，不构成任何安全保证。

## 核心功能

- 录制指定窗口，或整个屏幕。
- 在平台与权限允许时录制麦克风与系统音频。
- 摄像头画中画叠加，支持拖动定位、镜像与形状选项。
- 自动或手动缩放，可调节缩放深度、时长、缓动与像素级位置；自动缩放会跟随光标移动。
- 自定义光标大小、平滑、点击特效、主题、高亮区域，以及录制后的光标轨迹平滑。
- 为配音自动生成字幕，在打包版本中使用随包的模型资源在本机完成。
- 壁纸、纯色、渐变，或自选背景图片。
- 动态模糊与纯色块遮挡区域。
- 时间轴上的裁剪、剪切与分段变速。
- 文本、箭头、图片与图形标注。
- 时间轴吸附辅助线与音频波形，便于剪切。
- 可自定义的键盘快捷键。
- 导出 MP4 或 GIF，支持多种画幅比例与分辨率。
- 支持的界面语言：阿拉伯语、英语、西班牙语、法语、意大利语、日语、韩语、葡萄牙语（巴西）、俄语、土耳其语、越南语、简体中文、繁体中文。

## 安装与构建

发布产物（若有）附在本分支的 GitHub Releases 上。标签必须与 `package.json` 完全一致，例如 `v1.5.0-fork.4`。推荐下载最新的稳定 GitHub Release。

本地开发与渲染层构建：

```bash
npm ci
npm run build-vite
npm test
```

Windows 打包：

```powershell
npm run build:native:win
npm run test:wgc-helper:win
npm run test:wgc-parity:win
npm run test:wgc-fault:win
npm run test:cursor-sampler:win
npm run build:win
```

Linux 打包：

```bash
npm run build:linux
```

打包会执行 `scripts/before-pack.cjs`，它确保离线字幕模型与 ONNX Runtime wasm 资源存在于 `caption-assets/` 下，然后由 electron-builder 复制进应用资源。

## 发布流程

- `npm run lint`、`npm test` 与 `npm run build-vite` 是本地的基线门禁。
- `.github/workflows/ci.yml` 在 pull request 与 `main` 上运行 lint、i18n 一致性检查、类型检查、单元测试、浏览器测试与 Vite 构建，另有一个 Rust lint 任务和一个在 `windows-2022` 上运行的 Rust 构建与测试任务。
- `.github/workflows/build.yml` 是手动触发的工作流，用于构建未签名的 Windows 与 Linux 产物。
- `.github/workflows/release.yml` 在 `v*` 标签上运行，校验标签与源码 SHA，构建 Windows 与 Linux 产物，验证打包后的 Windows 原生负载，记录构建来源信息，然后发布带 SHA-256 校验和的扁平资产集。
- 应用的更新检查在主进程中读取稳定 GitHub Releases，只呈现下载链接。

## 录制与导出的存储

- 新录制由主进程写入生效的录制目录。默认是应用数据下的 `recordings` 文件夹；用户可通过系统目录选择器指定自定义文件夹。
- 自定义录制文件夹在主进程中校验。盘符根目录、用户配置文件根目录、应用数据根目录，以及指向这些受保护位置的符号链接或联接，都会被拒绝。
- 录制路径在录制开始或流打开时固定。会话清单与光标附属文件由实际视频路径推导。
- 录制进行中或收尾期间无法更改录制文件夹。
- 录制存储面板提供手动的保留清理。清理先生成计划，随后只删除生效录制目录内、由会话清单引用的 CloseScreen 会话产物。
- 录制所在磁盘空间不足只是警告，不是硬性阻断，也不会自动删除录制。
- 导出只会保存到该次导出通过系统保存对话框选定的文件路径。导出失败时会尽可能给出与文件系统相关的具体错误。

## 安全说明

详细的安全策略与隐私说明见 [SECURITY.md](./SECURITY.md) 与 [docs/PRIVACY.md](./docs/PRIVACY.md)。发布与人工 QA 的覆盖情况记录在 [docs/REGRESSION_CHECKLIST.md](./docs/REGRESSION_CHECKLIST.md)。

- 打包后的渲染层内容通过特权 `app://bundle` 协议提供，并配有严格的内容安全策略。
- 经由 `app://bundle/_media/` 提供的本地媒体，必须已由选择器、项目加载或录制目录规则批准。
- `read-binary-file` 仅接受已批准的路径，不会自动批准渲染层传入的任意路径。
- 预加载脚本只暴露收窄的 IPC 接口，启用 `contextIsolation`，禁用 `nodeIntegration`。
- 外部链接通过协议白名单打开。
- 仓库中不存放凭据与发布密钥。GitHub Actions secrets 是发布凭据唯一受支持的存放位置。

## Windows 原生助手

默认的 Windows 助手源码位于 `electron/native/rust`；过渡期的回退实现仍保留在 `electron/native/wgc-capture`。运行时选择、回退方式、随包文件名与诊断命令，记录在 [electron/native/README.md](./electron/native/README.md)。迁移历史与遗留限制跟踪在 [docs/engineering/windows-native-recorder-roadmap.md](./docs/engineering/windows-native-recorder-roadmap.md)。

## 许可

本项目采用 [MIT 许可](./LICENSE)。使用本软件即表示你同意，作者不对因使用本软件而产生的任何问题、损害或索赔承担责任。
