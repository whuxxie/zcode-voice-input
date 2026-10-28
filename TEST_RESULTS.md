# TEST_RESULTS — 测试结果记录

最后更新：2026-10-28。测试框架：`node --test`（Node v24.19.0）。
运行方式：`cd G:/xxie/zcode-voice-input && node --test tests/*.test.mjs`

## 总体结果：67/67 全部通过（2026-10-28 最终运行）

```
ℹ tests 67   ℹ pass 67   ℹ fail 0   duration_ms 2831
```

## 按规约 14 类测试对照

| # | 规约要求的测试 | 自动化文件 | 结果 | 说明 |
|---|---|---|---|---|
| 1 | ASR WebSocket 协议解析 | tests/volcano-protocol.test.mjs (9) | ✅ 通过 | 头字节规范、序号、LAST_NO_SEQ、gzip、粘包/半包逐字节流式解析、错误帧(45000081)、热词去重、非法版本 |
| 2 | Mock 服务器识别 | tests/relay.test.mjs + mock-asr.js | ✅ 通过 | hello→ready→partial→stop→final 全链路、nostream 模式 |
| 3 | 音频采样率和数据格式 | tests/audio-format.test.mjs (6) | ✅ 通过 | s16le 16k 时长计算、16k/44.1k/48k 窗口切分、静音判定、奇数字节容错 |
| 4 | 中间与最终结果合并 | tests/volcano-asr.test.mjs (3) | ✅ 通过 | partial 为累计全量文本（不重复拼接）、definite 分句按 key 去重、final 兜底 |
| 5 | 网络断开与超时 | tests/volcano-asr.test.mjs (5) | ✅ 通过 | 建连重试、连接超时、中途断流(E_STREAM_BROKEN 不可续传)、结束超时、空闲超时、55000031 可重试标记 |
| 6 | 重复点击与取消 | tests/state-machine.test.mjs + relay 并发测试 | ✅ 通过 | 状态机禁止并发会话、cancel 立即中止且无 final、maxSessions 限制第二连接、token 错误拒绝 |
| 7 | 空白音频 | relay.test.mjs (2) | ✅ 通过 | 静音→E_ASR_45000002、无音频直接 stop→报错 |
| 8 | 短/长语音 | relay.test.mjs (2) | ✅ 通过 | 300ms 单句；50 分句 10 秒 100 分片渐进 partial |
| 9 | 中英文术语处理 | tests/term-processor.test.mjs (9) | ✅ 通过 | 18 个规约术语齐备、springboot→Spring Boot 整词、变量名不受损、热词去重限量、重复清理、默认保守 |
| 10 | 密钥保护与日志脱敏 | term-processor + host-compat | ✅ 通过 | 源码无硬编码凭据（高熵扫描）、voice_status 不含密钥值、redactSecrets 生效、日志走 MCP logging 并脱敏 |
| 11 | 插件 UI 交互（状态机） | tests/state-machine.test.mjs (5) | ✅ 通过 | 状态机纯函数测试；完整 DOM 交互需在宿主内人工验证（见"人工验证"节） |
| 12 | ZCode 宿主兼容性 | tests/host-compat.test.mjs (8) | ✅ 通过 | 清单 schema、${ZCODE_PLUGIN_ROOT}/${user_config}、resources/list+read 带 _meta(csp/permissions)、mimeType profile=mcp-app、8MB 上限、面板自包含、-32601、官方 `zcode plugins validate` = **"Plugin manifest is valid"** |
| 13 | 安装包独立启动 | tests/package.test.mjs (4) | ✅ 通过 | zip 构建含 sha256、解压独立运行 MCP 服务器、市场清单源存在 |
| 14 | 禁用/重启/卸载 | scripts + 实际 CLI 运行 | ✅ 通过（实测） | 真实 CLI 循环：disable→enabled:false；enable→enabled:true；uninstall→列表移除；重装→enabled:true（最终保持已安装启用） |

## 联调证据（真实环境）

- `zcode plugins validate plugin` → `Plugin manifest is valid`（官方 CLI 校验通过）
- `zcode plugins list --json` → `zcode-voice-input@dev-zcode-voice-input-local`:
  `enabled:true, declaredMcpServerNames:["voice-input"], mcpServerNames:["plugin:zcode-voice-input:voice-input"], skillCount:1, diagnostics:[]`
- 已安装缓存路径实际启动：initialize ✓ / resources/read ✓（panel 580KB, `_meta.ui.csp.connectDomains=["ws://127.0.0.1:<port>"]`, permissions={microphone, clipboardWrite}）

## 必须人工验证的事项（无法自动化，如实区分）

1. **真实麦克风录音**：需要物理麦克风与用户口述。面板已实现 getUserMedia→AudioWorklet→16k PCM，但"真实录音→真实文字"需人工验证。
2. **真实火山引擎凭据联调**：未提供凭据，未连接真实 wss://openspeech.bytedance.com。协议实现基于官方文档+官方协议规范完成并通过协议级测试，但未经真实服务端往返验证。
3. **麦克风授权弹窗**：面板声明 `permissions.microphone`，宿主会弹授权提示（已从宿主二进制确认该机制），但实际点击"允许"需人工操作。
4. **桌面端面板实际渲染**：需要在 ZCode 桌面端新会话中打开面板人工确认（重启 ZCode 后）。
5. **粘贴到聊天输入框**：复制按钮写入剪贴板已声明 clipboardWrite；最终"Ctrl+V 粘贴→Enter 发送"由用户操作。
6. **Ubuntu/Wayland/X11**：本机为 Windows 11。跨平台代码已就绪，Linux 行为未实测（见 KNOWN_LIMITATIONS.md）。

## Mock 与真实的边界

- 所有自动化测试基于 Mock 后端与协议级假服务器；**不得伪称真实 API 已联通**。
- 配置真实凭据后（插件设置 → 火山引擎 App Key 或 App ID+Access Token），后端自动切换为真实模式（voice_status 可查 backendMode）。
