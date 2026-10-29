# PROGRESS — ZCode Voice Input

> 每轮开始先读本文件与 TASK_QUEUE.md / TEST_RESULTS.md / INSTALL_STATUS.md / KNOWN_LIMITATIONS.md。

## 目标
在 Ubuntu 24.04 上开发真正可安装、可使用的 ZCode 桌面端插件「ZCode Voice Input」：
点击麦克风 → 录音 → 火山引擎豆包流式语音识别 2.0 → 实时预览 → 用户编辑 →
放入 ZCode Agent 输入区域（默认绝不自动发送）。

## 环境事实（已核实 2026-10-27）
- Ubuntu 24.04.5 LTS，**X11** 会话（XDG_SESSION_TYPE=x11），GNOME。
- 音频栈 **PipeWire**（wpctl 可用，pulse 兼容层存在；arecord 可用）。
- ZCode 桌面 **3.16.3-8992**（deb，/opt/ZCode，Electron app.asar）。
- ZCode CLI：`/opt/ZCode/resources/glm/zcode.cjs`（v0.17.0），支持
  `plugins list|install|uninstall|enable|disable|update|validate|marketplace`。
- Node v26.5.1（nvm），npm 可用。

## ZCode 插件系统研究结论（官方文档 + app.asar 逆向，均以本机为准）
- 插件清单 `.zcode-plugin/plugin.json`（**非** VS Code 扩展格式）。
- 组件：`commands/`(md)、`skills/`(SKILL.md)、`agents/`、`hooks/hooks.json`、
  `mcpServers`（或 `.mcp.json`）、**`ui.surfaces`**（UI 插件页面）。
- UI surface：`{id, title, icon, server, resourceUri: "ui://<name>/<file>.html", availability}`。
  server 必须以 `text/html;profile=mcp-app` 注册该资源（MCP Apps 协议）。
- 页面 ↔ 宿主桥：官方 `@modelcontextprotocol/ext-apps`（App 类）。可用 API（官方 UI_PLUGIN.md）：
  - `callServerTool`（与 agent 同权限）、`readServerResource`
  - `sendMessage({role:"user",content})` —— **会直接发送用户消息**（默认禁用）
  - `updateModelContext({content,structuredContent})` —— 附加为输入区可移除「插件上下文」芯片，**不自动发送**（官方支持）
  - `requestDisplayMode`、`getHostContext`、`sendLog`、`setWidgetState` 等
- **未发现任何"写入聊天输入框草稿"的官方 API**（app.asar 中无 ui/setInput / draft 类方法）。
  → 输入策略：① updateModelContext 附加上下文芯片（官方、不自动发送）；
    ② 声明 `clipboardWrite` 权限后 `navigator.clipboard.writeText` 复制，用户 Ctrl+V 粘贴成可编辑草稿；
    ③ 面板内置可编辑 textarea + 复制按钮兜底。绝无自动发送。
- **麦克风**：app.asar 宿主 schema 支持资源 `_meta.ui.permissions` 声明
  `camera/microphone/geolocation/clipboardWrite`（Z3 常量表），
  运行时走 Electron setPermissionRequestHandler → 宿主授权流程（有 session-allow/站点设置/弹窗）。
  待真机验证弹窗与授权持久化。
- **CSP**：资源 `_meta.ui.csp.connectDomains` → connect-src（默认无网络）。
  声明 `ws://127.0.0.1`/`http://127.0.0.1` 以允许页面连本地回环音频桥（待真机验证是否接受）。
- 市场安装（官方 PLUGIN_DEVELOPMENT.md）：构建 `marketplace.json` + 插件目录 →
  CLI `zcode plugins marketplace add <dir> --scope user` → `zcode plugins install <name>@<market>` →
  `enable`。桌面端同样从 `~/.zcode/cli/plugins` 读取（本机已装 20 个官方插件佐证共享存储）。
- 官方插件范例：blender（ui.surfaces + dist/server.mjs 单文件 bundle + ui/dist/panel.html）。
  参考其结构：**server.mjs 用 esbuild 打成单文件、零运行时依赖**。

## 火山引擎豆包流式 ASR 2.0 协议结论（官方文档）
- 端点（全双工，wss）：
  - `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel` —— 双向流式（实时）
  - `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async` —— 优化版（VAD 分句 definite + 可选二遍识别 enable_nonstream）→ **默认「分句识别」模式**
- 鉴权头（旧控制台）：`X-Api-App-Key: <AppID>`、`X-Api-Access-Key: <AccessToken>`；
  新控制台：`X-Api-Key: <AppKey>`；`X-Api-Resource-Id: volc.seedasr.sauc.duration`(2.0小时版) 或 `volc.seedasr.sauc.concurrent`(2.0并发版)；`X-Api-Request-Id`、`X-Api-Connect-Id`: UUID。
- 二进制协议：4 字节头 [ver|hdrsize=0x11][msg_type<<4|flags][serialization<<4|compression][0x00]，
  msg_type: full=0x1 audio=0x2 server_resp=0x9 error=0xf；flags: none=0 last_no_seq=0b10 neg_seq=0b11；
  full/audio 帧为 header + 4B 大端长度 + gzip(payload)。
- 首包 JSON：`{user:{uid}, audio:{format:"pcm",rate:16000,bits:16,channel:1}, request:{model_name:"bigmodel", enable_punc:true, enable_itn:true, enable_ddc:false, show_utterances:true, result_type:"full", vad_segment_duration, end_window_size, corpus:{context:"{\"hotwords\":[{\"word\":\"Spring Boot\"}]}"}}}`。
  热词直传 context JSON（双向流式限 100 token）。语种 zh/en/混合默认支持（勿设 language）。
- 结果 JSON：`{audio_info:{duration}, result:{text, utterances:[{definite,start_time,end_time,text,words}]}}`。
- 结束：最后一包 flags=0b10（无负序号）或 0b11；服务端最终响应 sequence=-1 或 flags=0b11。
- 错误码：20000000 成功；45000001 参数错；45000002 空音频；45000081 等待超时；45000151 音频格式错；55xxxxx 服务端。
- 音频建议 200ms/包（16k×16bit mono = 6400B/包）。
- **凭据**：本机无真实凭据；userConfig 敏感项（sensitive）由用户在插件设置里填；
  凭据只存在 MCP server 侧（`${ZCODE_PLUGIN_DATA}` 下 0600 文件），绝不进前端页面/日志/Git。

## 架构（已定）
```
ZCode 桌面
└─ 插件 zcode-voice-input
   ├─ MCP server (stdio, dist/server.mjs 单文件)
   │   ├─ ui://voice-input/panel.html 资源 (text/html;profile=mcp-app)
   │   ├─ 工具: voice_get_session / voice_config_get|set / voice_status
   │   ├─ 本地回环 WS 音频桥 (127.0.0.1:0, 一次性 token, Origin 校验)
   │   └─ Volcano WSS 客户端 (bigmodel_async 默认 / bigmodel 可选) + 术语处理
   └─ UI 面板 (panel.html, ext-apps App)
       ├─ getUserMedia 16k PCM16 mono → AudioWorklet → 回环 WS 二进制帧
       ├─ 实时 partial/final 预览 + 可编辑结果框 + 复制/附加上下文/取消
       └─ 绝不自动发送（无 sendMessage 调用）
```
选择回环 WS 而非高频 MCP 工具传音频：单条持久连接、双向低延迟，
规避 MCP 请求开销（需求三明确要求）。

## 当前状态
- [x] 阶段1 环境与插件能力调查（含 app.asar 逆向证据，见上）
- [x] 阶段2 架构确定
- [ ] 阶段3 火山 ASR 客户端 + Mock
- [ ] 阶段4 MCP server + UI 面板
- [ ] 阶段5 术语处理
- [ ] 阶段6 Ubuntu 兼容性脚本
- [ ] 阶段7 自动化测试
- [ ] 阶段8 构建打包 + 本地市场安装 + 实际启用
- [ ] 阶段9 实机验收

## 里程碑日志
- 2026-10-27 完成 ZCode 插件机制调研与协议调研，确定架构，开始工程搭建。
