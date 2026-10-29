# KNOWN_LIMITATIONS — 已知限制（如实记录）

更新时间：2026-10-28

## 1. 环境差异：本机为 Windows 11；Ubuntu 通过 CI 保证可安装性

开发与实机验证在 **Windows 11 (10.0.26300, x64)** 完成，ZCode 桌面端位于 `D:\Program Files\ZCode`
（另有用户级安装 `C:\Users\<你>\AppData\Local\Programs\ZCode`）。

针对 Ubuntu 的保障措施：
- 插件全部为跨平台 JS/HTML（Node + Electron webview），不含任何 Windows 专属 API。
- **GitHub Actions CI 在 `ubuntu-latest` 与 `windows-latest`（Node 22/24）运行完整测试套件与构建**
  （`.github/workflows/ci.yml`），保证"装得上"的核心链路在 Linux 上持续可验证。
- 安装/卸载/体检脚本已跨平台：`scripts/doctor.mjs` 与 `scripts/install-local.mjs`
  自动搜索 Linux 常见 ZCode 安装位置（`/usr/share/zcode`、`/opt/*`、`~/.local/share`、snap、AppImage 解包目录），
  支持 `--zcode` 参数与 `ZCODE_CLI` 环境变量；图形界面安装流程两平台一致。
- Ubuntu 实机端到端（真实桌面 + 麦克风）仍需用户在 Linux 机器上按 docs/INSTALL.zh-CN.md 执行一次。

## 2. 真实火山引擎联调未完成（等待用户凭据）

- 未提供真实凭据（App Key 或 App ID+Access Token），**未连接过真实 wss://openspeech.bytedance.com**。
- 协议实现基于官方文档核实（端点、鉴权头、二进制帧、时序、错误码、热词 corpus.context），
  并通过 67 项自动化测试（含协议级往返、假服务器时序模拟），但**不等于真实服务端联调通过**。
- 配置凭据后插件自动切换真实模式；首次联调如遇协议细节差异，按错误码
  （45000001 参数 / 45000151 音频格式 / 55000031 繁忙）对照官方文档修正即可，架构已就绪。

## 3. 无法自动化、必须人工验证的环节

- 真实麦克风录音 → 真实文字（需物理麦克风与用户口述）。
- ZCode 桌面端内面板的实际渲染与授权弹窗点击（需重启桌面端人工操作）。
- 复制后在聊天输入框 Ctrl+V 粘贴的最终体验。

## 4. 输入框集成方式的边界（官方能力限制，已如实验证）

- **ZCode 插件系统没有"写入聊天输入框草稿"的官方 API**（已核实官方文档 + 主程序二进制）。
- 宿主官方能力为：`ui/message`（发送后续消息，宿主弹**可编辑确认框**由用户确认）与
  `ui/update-model-context`（附加上下文）。
- 因此实现为三层方案（符合任务规约的降级路径）：
  1. 📥 复制并准备粘贴（默认，写剪贴板 + 操作指引）；
  2. ✈️ 提交到会话（显式按钮，宿主确认框，用户可编辑后确认发送）——非自动发送；
  3. 复制文本 + Ctrl+V 保底。
- **默认不自动发送**：插件无任何自动触发 ui/message 的路径。
- 剪贴板读取被宿主永久拒绝（Permissions-Policy `clipboard-read=()`），插件只写不读。

## 5. Ubuntu/Wayland/X11 具体项（未实测，给出预判）

| 项 | 预判 | 状态 |
|---|---|---|
| X11 下粘贴 | Ctrl+V 正常 | ⏳ 未实测 |
| Wayland 下粘贴 | 取决于输入框（Electron 内部输入框不受 Wayland 剪贴板限制） | ⏳ 未实测 |
| 全局快捷键 | 未实现（避免与 ZCode 快捷键冲突；未发现宿主快捷键注册 API） | ❌ 未实现，属可选增强 |
| PipeWire 麦克风 | 经 Electron/Chromium 采集，正常桌面会话可用 | ⏳ 未实测 |
| 系统麦克风权限 | Ubuntu 需要桌面门户授权（chromium 请求音频录制） | ⏳ 未实测 |

## 6. 功能边界与设计取舍

- **热词机制**：使用火山引擎官方 `corpus.context` 热词（双向流式限 100 token）；
  未接入自学习平台 boost 表（用户可后续在配置中加 boosting_table_id，代码已预留）。
- **后处理默认全部关闭**（保留原始识别结果）；"整词规范技术名词写法"仅在用户显式开启后
  按词典整词替换，不触碰代码变量名/命令参数（有单测约束）。
- **麦克风设备选择**：面板支持枚举/切换（权限授予后），但当前会话内切换设备需重新开始录音。
- **中继安全**：仅监听 127.0.0.1 随机端口 + 随机 token（每服务器进程一次性）+ Origin 校验
  （zcode-sandbox:// 或空）；并发会话上限 2。
- **面板单文件构建**：panel.html 为自包含产物（约 580KB，含官方 ext-apps SDK），源码在
  `panel/src/`，修改后需 `node scripts/build-panel.mjs` 重建。
- **录音上限**：面板未设硬上限；火山引擎按时长计费，长音频会持续计费（面板显示时长供用户控制）。
- **扬声器回放**：录音时不采集系统声音，仅麦克风。

## 7. 已知的小问题

- 极端情况下（宿主重建沙箱实例），面板会重新初始化并重新请求中继信息（设计内行为）。
- 分句模式下 partial 频率由识别服务决定，面板 100ms/片的发送节奏为官方建议值。
- `scripts/install-local.mjs` 在 zcode CLI 弹出交互确认的场景会提示需要 `--force`
  （脚本已对 uninstall/add 传 --force；如遇新场景按提示操作即可）。
