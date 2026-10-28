# 故障排查（中文）

按症状定位。通用三步先行：**① 重启 ZCode（完全退出）② `node scripts/doctor.mjs` 体检 ③ 会话里让 Agent 调用 `voice_status` 看状态。**

## 面板打不开 / 找不到录音界面

| 现象 | 处理 |
|---|---|
| 在输入框旁看到"语音输入"但点不出录音 | 那是**技能**（提示词），不是面板。在对话里直接说 **"打开语音输入面板"**——面板会作为卡片出现在对话中，内含麦克风按钮。 |
| 想从设置里打开 | 设置 → 插件 → **点击"语音输入"进详情页** → **「打开」**（需当前项目有已打开的会话）。 |
| 说"打开语音面板"后 Agent 没调工具 | 让 Agent 调用 `voice_panel` 工具（可以明说"调用 voice_panel 工具"）；确认插件已启用并重启过 ZCode。 |
| 安装/更新后没生效 | 完全退出（含托盘）再启动 ZCode。 |
| 面板打开报 "MCP App failed" | `zcode plugins list --json` 看 `diagnostics`；运行 `node scripts/doctor.mjs` 检查 Node 版本 ≥ 22。 |
| 设置里插件消失 | 市场注册指向的 `dist/local-marketplace` 目录被移动/删除。回到仓库目录重新 `node scripts/install-local.mjs`。 |

## 录音条（overlay）问题

| 现象 | 处理 |
|---|---|
| 安装了 overlay，重启后输入框旁没有 🎤 | 先 `node scripts/install-overlay.mjs status`。若显示"未安装"且安装时 ZCode 正在运行：多半是后台替换进程**等 2 小时没等到完全退出**，超时自动清理了待替换包——重跑 install，并在 **2 小时内**完全退出（托盘右键退出，仅关窗口不算）再重开。 |
| ZCode 自动更新后录音条消失 | 官方更新会覆盖 `app.asar`，注入行被冲掉。**插件本体、面板、凭据、词典均不受影响**（对话内面板仍可用）。重跑 `node scripts/install-overlay.mjs` 并完全重启 ZCode 即可恢复录音条。 |
| 录音条在，但按 F8 没反应 | 让 Agent 调 `voice_status` 确认插件服务在运行（中继端口就绪）；首次使用需在系统弹窗允许麦克风；按键可改：设置 → 插件 → 语音输入 → 配置 → `按住说话按键`。 |
| 气泡挡住对话文字 | v0.2.1 起气泡为宽长方形（280~600px）且限高，长转写文本在气泡内部滚动并自动停在最新文字；仍嫌遮挡可在录音时拖动窗口或直接 Esc 取消。 |

## 麦克风问题

| 现象 | 处理 |
|---|---|
| 点 🎤 提示权限被拒绝 | 两层授权都要允许：ZCode 沙箱弹窗 + 系统麦克风权限。Windows：设置→隐私→麦克风；Ubuntu：设置→隐私/声音，允许桌面应用录音（PipeWire 会话）。 |
| 停止后提示"空音频或无声" | 选错输入设备（⚙ 旁下拉框切换）；或系统里麦克风被其他应用独占；或音量过低（录音时长 > 1 秒且靠近麦克风再试）。 |
| Ubuntu 上完全枚举不到设备 | 确认 `pactl info` 能看到默认 source；Wayland 下确认桌面门户（xdg-desktop-portal）正在运行。 |

## 找不到凭据配置入口

| 现象 | 处理 |
|---|---|
| 设置→插件里只有安装/卸载按钮，没有"配置" | 配置不在列表行上。**点击插件名称进入详情页** → 展开 **「高级信息」** → 里面的 **「配置」** 区块才是凭据填写处。 |
| 详情页没有「高级信息」或「配置」区块 | 插件未启用或安装后未重启。先启用插件并完全重启 ZCode（配置区块随插件声明的 userConfig 渲染，禁用状态下可能不显示）。 |
| 已填凭据但面板仍显示 Mock 模式 | 未点「保存配置」，或保存后未重启/未新开会话。保存 → 完全退出重启 → 面板徽标变为真实模式。 |
| 点「保存配置」后密钥输入框变空 | **正常现象**：敏感字段保存后不回显（防旁人窥屏），值已保存（重新打开配置页可见"清除已保存密钥"按钮即代表有已存值）。验证方式：重启 ZCode 后面板徽标显示"真实模式"，或让 Agent 调用 `voice_status` 看 `credentialsConfigured: true`。 |

## 识别问题

| 现象 | 处理 |
|---|---|
| 面板徽标显示 "Mock 演示模式" | 未配置凭据。设置 → 插件 → ZCode Voice Input 填入 App Key（或 App ID+Access Token），重启 ZCode。 |
| 真实模式报 `E_ASR_45x` 错误 | 45x 为请求侧错误：检查凭据是否正确、资源 ID 是否与控制台开通的服务一致（`volc.seedasr.sauc.duration` vs `...concurrent`）。 |
| 真实模式报 `E_ASR_55000031/32` | 服务端繁忙/内部错误，稍后重试（插件已标记为可重试）。 |
| 报 `E_CONNECT_TIMEOUT` / `E_CONNECT` | 网络无法访问 `openspeech.bytedance.com:443`（检查代理/防火墙）。代理环境请为 ZCode 进程配置系统代理。 |
| 技术词识别偏差 | 在面板结果里手改一次；并用词典固化：让 Agent 调 `voice_set_dictionary`，如 `{"word":"openGauss","match":["open高斯"]}`。开启 ⚙ 里"启用内置术语热词"（默认开）。 |
| 识别文字重复拼接 | 正常情况不会出现（partial 为累计全量）。若出现请连同 `voice_status` 输出提 issue。 |

## 剪贴板 / 粘贴

| 现象 | 处理 |
|---|---|
| 复制失败 | 面板会自动全选文本，按 `Ctrl+C` 手动复制即可。 |
| 粘贴后格式异常 | 使用纯文本粘贴：Windows `Ctrl+Shift+V`（部分应用）/ Ubuntu `Ctrl+Shift+V`（终端）或中键；ZCode 输入框直接 `Ctrl+V` 即可。 |

## 安装 / CLI 问题

| 现象 | 处理 |
|---|---|
| `install-local.mjs` 找不到 zcode CLI | 用 `--zcode <路径>` 指定，或设 `ZCODE_CLI` 环境变量；Linux 常见位置 `/usr/share/zcode/resources/glm/zcode.cjs`、`/opt/ZCode*/...`、AppImage 需先挂载（`--appimage-extract`）。也可走图形界面安装（README 方式 B）。 |
| `plugin_variable_missing: ... user_config` | 旧版本清单问题，已修复（可选项带默认值）。更新到最新代码重新安装。 |
| `Unsupported or missing plugin source` | 市场清单不是 `dist/local-marketplace` 构建产物。重新运行 `node scripts/build-package.mjs` 后重新注册市场。 |
| 权限不足（Linux 系统级安装） | CLI 写用户级配置（`~/.zcode/`），无需 root；若 CLI 在系统目录且无法读取，检查安装完整性或改用 GUI 安装。 |

## 诊断数据收集（提 issue 时附上）

```bash
node scripts/doctor.mjs
node "<ZCode安装目录>/resources/glm/zcode.cjs" plugins list --json
```

面板内：⚙ 设置 截图 + 错误条完整文本（含 `[E_*]` 错误码）。**不要**提供任何密钥。
