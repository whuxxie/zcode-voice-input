---
name: voice-input
description: ZCode Voice Input 语音输入插件的使用与诊断。当用户想用语音向 Agent 口述开发需求、询问语音输入怎么用、或反馈语音识别问题时使用。
---

# ZCode Voice Input 语音输入

两种使用形态：

1. **主窗口录音条（推荐，需安装 overlay）**：输入框旁常驻 🎤 小按钮（不随对话滚动），
   输入法式操作——按住 PTT 键（默认 `F8`）说话、松开即把文字插入聊天输入框光标处；
   或按组合键（默认 `Ctrl+Shift+Space`）开始/结束，录音中 `Esc` 取消；也可单击 🎤 切换。
   按键可在 插件配置页 修改（pttKey / toggleKeys），改后完全重启 ZCode 生效。
2. **对话内面板（无需 overlay，备用）**：调用 `voice_panel` 工具在当前对话中渲染
   完整录音面板（录音→编辑→复制/确认提交）。

## 如何安装主窗口录音条

录音条需要修改客户端（给 app.asar 打一行注入补丁，与 zcode-token-usage-statusbar
同机制）。在插件仓库执行：

```bash
node scripts/install-overlay.mjs          # 安装（幂等；ZCode 运行中则退出后自动完成替换）
node scripts/install-overlay.mjs status   # 查看状态
node scripts/install-overlay.mjs uninstall # 卸载
```

安装后**完全退出并重启 ZCode**（托盘右键退出，仅关窗口不算）。若提示无权限，
用管理员 PowerShell 运行同命令。插件自身升级不影响注入（运行目录独立于插件缓存）。

## Agent 判断逻辑

- 用户想语音输入且已安装录音条 → 告知按住 `F8` 说话即可（或按配置的按键）。
- 用户说"打开语音输入面板/麦克风面板" → 调用 `voice_panel`（对话内渲染备用面板）。
- 用户报告录音条不见/失效 → 先 `voice_status` 确认服务正常；再让用户跑
  `install-overlay.mjs status`；旧面板卡死报 "MCP App connection is unavailable" 时
  重新调 `voice_panel` 即可。

## 工具（供 Agent 调用）

- `voice_panel`：在对话内渲染录音面板（备用形态）。
- `voice_status`：凭据/模式/中继端口/版本。不返回任何密钥值。
- `voice_get_settings` / `voice_set_settings`：后处理开关（默认全部保守）。
- `voice_get_dictionary` / `voice_set_dictionary`：个人术语词典（热词）。

## 诊断

- 识别结果为演示文本 → Mock 模式：请用户在 插件配置页 填火山引擎凭据
  （新版控制台 App Key，或旧版 App ID + Access Token），重启会话。
- 录音条按钮出现但按了没反应 → `voice_status` 看中继是否就绪；overlay 依赖
  runtime.json（服务启动时发布，路径 ~/.zcode/zcode-voice-input/runtime.json）。
- 麦克风无声音 → 检查系统麦克风隐私设置与其他应用占用。
- 连接失败 → 看错误码（45000081 超时、55000031 繁忙可重试；45000151 音频格式问题）。

## 约束

- 录音条只把文字插入输入框（输入法式），绝不自动发送消息。
- 密钥仅存在插件 MCP 服务器进程，不下发面板/overlay/日志/仓库。
- overlay 注入会修改客户端 app.asar；用户应知情。卸载随时可用 uninstall 命令干净移除。
