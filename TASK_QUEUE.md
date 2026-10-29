# TASK_QUEUE — ZCode Voice Input

## 待办（按优先级）
1. [P0] 工程骨架：package.json、plugin.json、marketplace.json、构建脚本（esbuild 单文件 bundle）
2. [P0] `src/server/volc-asr-client.mjs`：豆包流式 2.0 二进制协议客户端（双向流式 + bigmodel_async 分句模式）
3. [P0] `src/server/mock-asr.mjs`：Mock ASR WS 服务（实现同协议，供离线测试）
4. [P0] `src/server/audio-bridge.mjs`：127.0.0.1 回环 WS 桥（一次性 token + Origin 校验 + 会话生命周期）
5. [P0] `src/server/credentials.mjs`：凭据安全存取（ZCODE_PLUGIN_DATA 0600 文件；永不入日志/Git/前端）
6. [P0] MCP server 主体：ui 资源注册、工具集（get_session/config/status）、协议粘合
7. [P0] UI 面板 panel.html：录音控制、状态、时长、实时预览、编辑框、复制/附加、错误提示、设备选择、防并发
8. [P1] 术语处理：程序员词典默认项 + 用户自定义词典 + 守卫式替换（不碰路径/数字/变量）
9. [P1] 自动化测试（node --test）：协议编解码、Mock 会话、合并去重、超时断连、取消、空音频、术语、脱敏、UI 交互（jsdom/手工断言）、打包自检
10. [P1] Ubuntu 兼容检测脚本（X11/Wayland、PipeWire、剪贴板、arecord）+ 文档
11. [P1] 构建 dist + 本地 marketplace + CLI 安装/启用（实机）
12. [P2] 真机联调：麦克风授权弹窗、CSP connectDomains、updateModelContext 芯片、clipboardWrite
13. [P2] 文档：README/INSTALL/UNINSTALL/使用说明

## 已完成
- [x] ZCode 插件系统调研（文档 + app.asar 逆向）
- [x] 火山豆包流式 ASR 2.0 协议调研
- [x] 架构定稿（回环 WS 音频桥方案）
- [x] 跟踪文件建立
