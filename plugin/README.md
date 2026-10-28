# ZCode Voice Input

ZCode 桌面端语音输入插件：点击麦克风 → 火山引擎豆包流式语音识别 2.0 实时转写 →
在面板内查看并编辑文字 → 复制粘贴到 Agent 输入区（或经宿主确认框提交）。**默认绝不自动发送。**

## 安装（本地市场，桌面端图形界面）

1. 本仓库目录下的 `market/` 即本地插件市场根目录（含 `marketplace.json`）。
2. ZCode → 插件市场 → 添加 → 添加插件市场 → 选择/粘贴 **本仓库 `market/` 目录的绝对路径**。
3. 进入该市场 → "语音输入" → 安装 → 启用（如要求确认请点击允许）。
4. 新开会话，工具栏出现 🎤 "语音输入"面板。

命令行方式（可选）：

```bash
node "<ZCode安装目录>/resources/glm/zcode.cjs" plugins marketplace add "<本仓库>/market" --scope user
node "<ZCode安装目录>/resources/glm/zcode.cjs" plugins install zcode-voice-input@<市场名> --scope user
```

## 配置凭据（二选一，均经安全配置界面注入，不入库不写日志）

- 新版控制台：`App Key`（X-Api-Key）
- 旧版控制台：`App ID` + `Access Token`

路径：设置 → 插件 → ZCode Voice Input → 配置。模型资源 ID 默认
`volc.seedasr.sauc.duration`（豆包流式语音识别大模型 2.0·按时长）。

未配置凭据时插件运行于 **Mock 模式**（识别结果为演示数据，用于体验界面与联调）。

## 使用

1. 打开会话侧边栏 → "语音输入"。
2. 🎤 开始录音（首次允许麦克风权限）→ 说话 → ⏹ 停止。
3. 检查/编辑识别文本（支持：结尾补标点、清理口头重复、技术名词整词规范等可选后处理，默认关闭）。
4. 📥 复制并准备粘贴到输入框 → 点击聊天输入框 → Ctrl+V → 自行检查后 Enter 发送。

## 卸载

设置 → 插件 → ZCode Voice Input → 卸载；或 `zcode plugins uninstall zcode-voice-input@<市场名>`。
随后可在插件市场中移除本地市场条目。

## 隐私与安全

- 音频仅发送至火山引擎识别服务（wss://openspeech.bytedance.com），经本机回环中继转发，密钥不离开插件服务器进程。
- 本地中继仅监听 127.0.0.1 随机端口，需一次性 token 鉴权。
- 插件不读取剪贴板（宿主固定拒绝 clipboard-read），仅写入剪贴板（已声明 clipboardWrite）。
