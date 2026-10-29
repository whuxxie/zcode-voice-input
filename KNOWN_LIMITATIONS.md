# KNOWN_LIMITATIONS — ZCode Voice Input

1. **无官方"写聊天输入框草稿"API**：ZCode UI Plugin 只有 `sendMessage`（=直接发送，需求禁止默认使用）
   与 `updateModelContext`（=附加可移除上下文芯片，不自动发送）。
   → 提供三种插入方式并明确区分，见 PROGRESS.md 架构节。
2. **麦克风权限需宿主授权**：UI 页面通过 `_meta.ui.permissions` 声明 microphone 后，
   首次使用会触发 ZCode 授权流程；若宿主策略拒绝则回退到「本地录音辅助」方案（尚未实现，仅在需要时启动）。
3. **凭据**：无真实火山引擎凭据时，真实 API 联通无法验证；Mock 覆盖协议与交互层。
4. （随开发持续补充）
