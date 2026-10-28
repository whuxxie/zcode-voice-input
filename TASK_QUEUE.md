# TASK_QUEUE — 任务队列（最终状态：全部可执行任务完成）

## 第一轮：核心插件（全部完成 ✅）
- [x] volcano-protocol.js：二进制帧编解码（4字节头/序号/gzip/JSON/错误帧）
- [x] volcano-asr.js：火山 WS 客户端（双控制台鉴权、启停时序、utterances 合并、重试/超时）
- [x] mock-asr.js：离线 Mock ASR（与 relay 接口一致，支持注入脚本/失败/断流）
- [x] relay.js：本地回环 WebSocket 中继（token 鉴权、Origin 校验、并发限制）
- [x] backend-factory.mjs：真实/Mock 统一工厂 + 热词注入 + 后处理
- [x] server.mjs：最小 MCP stdio 服务器（initialize/tools/resources + panel 资源 _meta）
- [x] panel：录音 UI（状态机、麦克风、实时预览、时长、编辑、复制、插入指引、确认提交）
- [x] term-processor.js：18 术语热词 + 个人词典 + 保守后处理（默认不改语义）
- [x] tests/*：67 项自动化测试全部通过（规约 14 类全覆盖）
- [x] 真实安装：marketplace add → install → enable 全部成功并实测生命周期

## 第二轮：GitHub 开源化 + Ubuntu 支持（全部完成 ✅）
- [x] 双语 README（README.md 英 / README.zh-CN 中），文档互链
- [x] docs/INSTALL.zh-CN.md + docs/INSTALL.en.md（Windows/Ubuntu 双平台安装指南）
- [x] docs/USAGE.zh-CN.md + docs/USAGE.en.md（使用说明）
- [x] docs/TROUBLESHOOTING.zh-CN.md + docs/TROUBLESHOOTING.en.md（故障排查）
- [x] install-local.mjs / uninstall.mjs / doctor.mjs 跨平台化（Linux 常见路径自动发现、ZCODE_CLI、--zcode）
- [x] scripts/doctor.mjs 环境体检（Node 版本/CLI 定位/官方校验/构建产物/音频栈提示）
- [x] .github/workflows/ci.yml：ubuntu-latest + windows-latest × Node 22/24 全套测试+构建
- [x] package.json scripts 跨平台化（build/test/doctor/install/uninstall/validate）
- [x] 新脚本在本机重装验证幂等（Added→Installed→Enabled→✅）+ 67/67 测试复归

## P1 尽力项（状态不变）
- [x] 麦克风设备选择（enumerateDevices，权限授予后可用）
- [ ] 全局快捷键：未实现（宿主无快捷键注册 API，避免与 ZCode 冲突；记录为可选增强）

## 阻塞/等待用户（唯一剩余）
- [ ] Windows 机：重启 ZCode 桌面端并打开"语音输入"面板做人工验收
- [ ] Windows 机：插件设置中配置真实火山引擎凭据（App Key 或 App ID+Access Token）后联调
- [ ] Ubuntu 机：按 docs/INSTALL.zh-CN.md 执行安装（doctor → install-local → 重启 ZCode）并人工验证录音

