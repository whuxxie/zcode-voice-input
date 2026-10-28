# ZCode 语音输入（ZCode Voice Input）

[English](./README.md) | [简体中文](./README.zh-CN.md) | [安装指南](docs/INSTALL.zh-CN.md) | [使用说明](docs/USAGE.zh-CN.md) | [故障排查](docs/TROUBLESHOOTING.zh-CN.md)

ZCode 桌面端的语音输入插件。**v0.2.0 起支持输入法式录音条**：输入框旁常驻 🎤 小按钮（不随对话滚动），按住 `F8` 说话、松开即把文字**直接插入聊天输入框光标处**；也支持组合键开关与单击切换。另有完整录音面板（录音 → 实时出字 → 检查修改 → 复制/确认提交）。语音识别采用**火山引擎豆包流式语音识别大模型 2.0**（`volc.seedasr.sauc.duration`）。

> **插件绝不自动发送任何消息。** 发送前的最后一次 Enter 永远由你自己按下。

已在 **Windows** 实测安装可用；插件完全跨平台（Node.js + Web 标准 API），并在 CI 中于 **Ubuntu Linux** 上跑完整测试套件。两个系统的安装方法见[安装指南](#安装)。

---

## 功能特性

- 🎤 ZCode 侧栏面板一键录音（MCP Apps UI，宿主沙箱隔离）
- ⏺ 双模式：**分句流式**（默认，实时部分结果 + 已定稿分句）与**整段识别**（停止后一次性返回）
- ✍️ 结果可编辑 —— 发送之前先看、先改
- 📋 复制到剪贴板 / 粘贴操作指引 / 可选的宿主确认提交（`ui/message`，ZCode 会弹出可编辑确认框）
- 🈶 中文 / 英文 / 中英混合识别，官方热词机制（`corpus.context`）+ 内置程序员术语表
  （Spring Boot、MyBatis、openGauss、PostgreSQL、Vue、Java、JavaScript、TypeScript、MQTT、GNSS、Cesium、Docker、Git、GitHub、API、JSON、SQL、WebSocket）+ 个人词典扩展
- ⚙️ 保守后处理（默认全部关闭）：结尾补标点、清理口头重复、技术名词整词规范 —— 不碰代码变量名、路径、端口、SQL
- 🔒 密钥只存在于插件 MCP 服务器进程（经插件 `userConfig` 注入），不出现在面板、日志、仓库；本地中继仅监听 `127.0.0.1` 且带一次性 token
- 🖥️ 麦克风设备选择、录音时长、错误提示（含可重试标记）、资源完整释放、防并发录音

## 工作原理

```
ZCode 桌面端 (Electron)
 ├─ 聊天输入框（Lexical）— 宿主无草稿写入 API；由用户粘贴/确认
 └─ 插件沙箱 webview (zcode-sandbox://plugin-*)
     └─ panel.html（AudioWorklet 麦克风采集 → 16 kHz s16le PCM；不含任何密钥）
         │  ws://127.0.0.1:<端口>  （每次启动随机 token + Origin 校验；
         ▼                          宿主 CSP 规范化器明确允许环回 ws）
     插件 MCP 服务器（Node stdio 进程 — 全系统唯一持有密钥的位置）
     ├─ 本地回环 ASR 中继（最小 RFC6455 服务端，随机端口）
     ├─ 后端工厂：真实火山引擎 / Mock（离线演示与测试）
     └─ 术语处理（官方热词注入 + 保守后处理）
```

## 安装

前置条件：**ZCode 桌面端** + `PATH` 中有 **Node.js ≥ 22**（插件 MCP 服务器需要；`node --version` 检查）。

先运行环境体检：

```bash
node scripts/doctor.mjs
```

### Windows

```powershell
# 在仓库根目录
node scripts/install-local.mjs
```

脚本会构建面板、生成 `dist/local-marketplace` 本地市场、并通过捆绑的 ZCode CLI
（`<安装目录>/resources/glm/zcode.cjs`，自动发现；可用 `--zcode <路径>` 或 `ZCODE_CLI` 环境变量覆盖）
注册市场并安装启用插件。

### Ubuntu Linux

```bash
# 需要 Node.js 22+（推荐 nvm：nvm install 22）
node scripts/doctor.mjs          # 体检 node、定位 zcode CLI、校验清单
node scripts/install-local.mjs   # 流程与 Windows 相同；自动搜索
                                 # /usr/share/zcode、/opt/*、~/.local/share、AppImage 等常见位置
```

若 CLI 未找到，使用**图形界面流程（两个系统完全一致）**：

1. ZCode → **插件市场 → 添加 → 添加插件市场** → 粘贴 `dist/local-marketplace` 的绝对路径。
2. 进入该市场 → **ZCode Voice Input** → **安装** → 启用。
3. 完全退出并重启 ZCode，新开会话即可。

详细图文步骤：[安装指南（中文）](docs/INSTALL.zh-CN.md) · [Install guide (English)](docs/INSTALL.en.md)

### 配置凭据

精确入口（配置区块藏在插件详情页的"高级信息"里）：

1. ZCode → **设置** → **插件**。
2. 在已安装列表中点击 **ZCode Voice Input（语音输入）**，进入插件详情页。
3. 展开 **「高级信息」**（More details）。
4. 其中的 **「配置」** 区块即为凭据填写处（二选一）：
   - **App Key**（新版语音控制台，请求头 `X-Api-Key`），或
   - **App ID + Access Token**（旧版控制台，请求头 `X-Api-App-Key` / `X-Api-Access-Key`）
5. 点击 **「保存配置」**，然后**完全退出并重启 ZCode**（或新开会话）生效。

资源 ID 默认 `volc.seedasr.sauc.duration`（豆包流式语音识别 2.0·按时长计费）。
未配置凭据时插件运行于明确标注的 **Mock 模式**（演示文本，不访问火山引擎）。

> 看不到「配置」区块？确认插件已启用且安装后重启过 ZCode；配置区块随插件声明的
> userConfig 出现，位于详情页「高级信息」展开区内（敏感字段带"显示密钥/清除已保存密钥"按钮）。

## 使用说明

两种形态（同一引擎、同一凭据处理）：

### 1. 输入法式录音条（推荐，v0.2.0 起）

🎤 小按钮**常驻吸附在聊天输入框旁**，不随对话滚动：

- **按住 `F8`** 说话，松开即把识别文字**插入聊天输入框光标处**（输入法式）。
- 或按 **`Ctrl+Shift+Space`** 开始、再按结束；录音中 `Esc` 取消；单击 🎤 也可切换。
- 按键可在插件配置页修改（`pttKey` / `toggleKeys`），改后完全重启 ZCode 生效。

此形态需一次性安装 overlay（给客户端 `app.asar` 追加一行 import，与
`zcode-token-usage-statusbar` 同机制；`uninstall` 可干净移除）：

```bash
node scripts/install-overlay.mjs           # 安装（幂等；ZCode 运行中则退出后自动完成替换）
node scripts/install-overlay.mjs status    # 查看状态
node scripts/install-overlay.mjs uninstall # 卸载注入行
```

安装后**完全退出**（托盘右键退出）并重启 ZCode。

### 2. 对话内面板（免补丁，备用）

1. 在对话里对 Agent 说 **"打开语音输入面板"**（或：设置 → 插件 → 语音输入详情页 → 「打开」）——
   带麦克风按钮的录音面板会出现在对话中/侧栏。
2. 🎤 开始录音（首次允许麦克风权限）→ 说话 → ⏹ 停止。
3. 检查/编辑文字（录音中实时预览区显示未定稿内容）。
4. 📥 **复制并准备粘贴** → 点击 ZCode 聊天输入框 → `Ctrl+V` → 自己按 Enter 发送。

详细说明：[使用说明（中文）](docs/USAGE.zh-CN.md) · [Usage (English)](docs/USAGE.en.md) · 问题排查：[故障排查](docs/TROUBLESHOOTING.zh-CN.md)

## 开发

```bash
npm install                     # 仅开发/测试依赖（ws）；插件运行时零依赖
npm test                        # 67 项测试：协议/客户端/中继/术语/音频/状态机/宿主兼容/打包/生命周期
node scripts/build-panel.mjs    # 重建自包含 panel.html
node scripts/build-package.mjs  # 重建 dist/local-marketplace + 分发 zip（含 sha256）
node scripts/uninstall.mjs      # 卸载（--remove-market 一并移除市场）
```

CI 在 `ubuntu-latest` 与 `windows-latest`（Node 22/24）上运行完整测试套件 ——
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

项目过程记录：[PROGRESS.md](PROGRESS.md) · [TASK_QUEUE.md](TASK_QUEUE.md) · [TEST_RESULTS.md](TEST_RESULTS.md) · [INSTALL_STATUS.md](INSTALL_STATUS.md) · [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)

## 隐私与安全

- 音频仅经回环中继发送至火山引擎识别端点；密钥绝不离开 MCP 服务器进程。
- 中继绑定 `127.0.0.1` 随机端口，要求每次启动随机 token；拒绝一切非环回连接。
- 沙箱无剪贴板读取权限（宿主强制）；面板只写不读。
- 不自动向 Agent 发送任何内容；可选"提交"必须经 ZCode 自带确认框由用户确认。

## 许可证

MIT — 见 [LICENSE](LICENSE)。内置第三方：`@modelcontextprotocol/ext-apps`（MIT）。
