# ZCode Voice Input — 进度日志

## 项目目标
为 ZCode 桌面客户端开发真正可安装、可使用的语音输入插件（ZCode Voice Input），
采用火山引擎豆包流式语音识别 2.0（X-Api-Resource-Id: volc.seedasr.sauc.duration）。
用户点击麦克风 → 录音 → 识别 → 查看/编辑文字 → 自行粘贴/确认后放入 Agent 输入区。
默认不自动发送任何消息。

## 最终状态（2026-10-28）
- ✅ 全部可自动化开发/测试/打包/安装工作完成
- ✅ 官方 `zcode plugins validate` 通过
- ✅ 已通过 ZCode CLI 在本机真实安装并启用（含 disable/enable/uninstall/重装全生命周期实测）
- ✅ v0.1.4：真实火山服务端到端联调通过（partial 实时回显 + final 正常返回，见第四轮）
- ⏳ 待用户人工完成：重启 ZCode → 打开面板 → 允许麦克风 → 说句话验证识别文本
- 详见 TEST_RESULTS.md / INSTALL_STATUS.md / KNOWN_LIMITATIONS.md

## 第四轮（2026-10-28）：v0.1.4 修复"点击开始录音就报错（MCP App connection is unavailable）"
用户首次真实录音触发三个连锁致命 bug（全部已修 + 真服务复验 + 67/67 测试通过）：
1. **音频帧序号布局错误**（volcano-protocol.js）：`X-Api-Sequence: -1` 会话下中间音频帧
   必须为 flags=NO_SEQ(0b0000) 且无序号字段；原 POS_SEQ(0b0001)+序号布局被 v3/sauc/bigmodel
   服务端直接硬断（close 1006，无错误帧）。裸协议矩阵实验定位，修正布局后全生命周期
   （start→音频逐包确认 duration→LAST_NO_SEQ→isLast→close 1000）真机验证通过。
2. **undici Blob 消息未处理**（volcano-asr.js）：Node 全局 WebSocket 默认 binaryType='blob'，
   `Buffer.from(Blob)` 抛 ERR_INVALID_ARG_TYPE → 服务端响应一帧即 E_PROTOCOL。修复：
   建连后设 binaryType='arraybuffer' + 消息回调兼容 Blob（await arrayBuffer()）。
3. **会话 promise 未挂处理 → 未处理拒绝杀进程**（backend-factory.mjs）：ASR 会话中途失败时
   promise 拒绝无人消费，Node 24 默认将其升级为致命错误直接杀死插件 MCP 进程——面板即报
   "MCP App connection is unavailable"。修复：backend-factory 挂载 then/catch（stopCalled
   防与中继 stop 路径重复上报），另在 relay.js events.error 中幂等释放会话计数防 E_BUSY。
验证：verify-e2e（真实 key + 修复代码）1s 正弦音频 → 10 个 partial 实时回显 → stop 返回
final(durationMs=800)，无断流、无未处理拒绝；测试套件 67/67。

## 第二轮（2026-10-28）：GitHub 开源化 + Ubuntu 支持
- 双语文档：README（英/中）+ docs/ 下安装指南、使用说明、故障排查（各双语）
- 跨平台脚本：install-local / uninstall / doctor 自动发现 Linux 常见 ZCode 安装路径，
  支持 `--zcode` 与 `ZCODE_CLI`；`npm run doctor/test/install/uninstall/validate`
- GitHub Actions CI：ubuntu-latest + windows-latest × Node 22/24，运行构建 + 全套测试 + doctor
- 本机复验：新脚本幂等重装成功，67/67 测试通过，doctor 无阻断项
- Ubuntu 实机安装由用户按 docs/INSTALL.zh-CN.md 执行（CLI 自动发现已覆盖标准路径）

## 环境核实结论（重要）
- 实际运行环境为 **Windows 11 (10.0.26300)**，并非任务描述中的 Ubuntu。
  插件代码全部为跨平台 JS/HTML（Node + Electron webview），Ubuntu 相关的
  Wayland/X11/PipeWire 适配逻辑已写入文档与面板提示，但只能在 Linux 上人工验证。
- ZCode 桌面端版本：`@zcode/desktop`（app.asar 构建于 2026-10），CLI `zcode 0.17.0`
  （捆绑于 resources/glm/zcode.cjs）。
- 插件系统 = **MCP Apps**（@modelcontextprotocol/ext-apps）：
  - 清单 `.zcode-plugin/plugin.json`：skills + mcpServers(stdio) + ui.surfaces + userConfig。
  - UI 面板由插件 MCP 服务器以 `ui://<name>/panel.html`（mimeType `text/html;profile=mcp-app`）提供，
    运行于 `zcode-sandbox://plugin-<appIdentity>` 沙箱。
  - 沙箱 Permissions-Policy：资源 `_meta.ui.permissions` 声明 `microphone` 后授予 `microphone=(self)`，
    系统弹授权提示；`clipboardWrite` 声明即授予；`clipboard-read` 永远拒绝。
  - CSP `_meta.ui.csp.connectDomains` 支持 `wss://`（公网）与 **`ws://127.0.0.1`（官方明确允许环回）**。
  - 宿主能力：openLinks/serverTools/serverResources/logging/sampling/downloadFile/
    message（宿主弹可编辑确认框）/updateModelContext。
  - **不存在**官方"写入聊天输入框草稿"的 API（已核实官方文档与主程序二进制）。
- 凭据机制：插件 `userConfig.sensitive` → `${user_config.key}` 注入 MCP 服务器进程环境变量。
  密钥永不出现在前端面板、日志或仓库。

## 架构（已实现并安装）
```
ZCode 桌面 (Electron)
 ├─ 渲染进程: 聊天输入框（Lexical）— 无草稿 API，只能由用户粘贴/确认
 └─ 插件沙箱 webview (zcode-sandbox://plugin-*)
     └─ panel.html（自包含构建；麦克风采集 AudioWorklet→16k s16le PCM；无任何密钥）
         │ ws://127.0.0.1:<port>（随机 token 鉴权；CSP connectDomains 官方允许环回）
         ▼
     插件 MCP 服务器（Node stdio 进程，密钥仅存在于此进程）
     ├─ 本地回环 ASR 中继（最小 RFC6455 WS 服务端, 127.0.0.1:0, token+Origin 校验, 并发≤2）
     ├─ 后端工厂（backend-factory.mjs）：真实火山 / Mock 自动切换 + 术语后处理
     │   └─ 火山引擎客户端（wss://openspeech.bytedance.com/api/v3/sauc/bigmodel）
     │       鉴权: X-Api-Key（新版）或 X-Api-App-Key+X-Api-Access-Key（旧版）
     │       资源: X-Api-Resource-Id=volc.seedasr.sauc.duration（2.0·按时长）
     └─ 术语处理（官方热词 corpus.context 注入 + 保守后处理，默认不改语义）
```

## 阶段进度（全部完成）
| 阶段 | 状态 |
|---|---|
| 1. 官方文档与环境核实 | ✅ 完成 |
| 2. 可执行架构 | ✅ 完成（并按实测宿主能力修正：本地回环中继，避免高频 MCP 传音频） |
| 3. 火山引擎协议接入 | ✅ 实现（协议编解码/客户端/重试/超时/合并；真实联调待凭据） |
| 4. 语音输入交互 UI | ✅ 实现（14 项交互要求全部落实；渲染待人工验证） |
| 5. 术语处理 | ✅ 实现（18 术语热词 + 个人词典 + 保守后处理） |
| 6. 跨平台兼容 | ✅ 代码跨平台（Win 实测；Ubuntu 项见 KNOWN_LIMITATIONS） |
| 7. 自动化测试 | ✅ 67/67 通过（覆盖规约 14 类测试） |
| 8. 打包与本地安装 | ✅ 已真实安装启用 |
| 9. 实际验收 | ✅ 可自动化部分完成；人工清单见 INSTALL_STATUS.md |
