# 安装指南（Windows / Ubuntu）

本文说明如何把 **ZCode Voice Input** 插件安装到 ZCode 桌面端。两个平台流程一致，差别只在路径。

- [1. 前置条件](#1-前置条件)
- [2. 环境体检](#2-环境体检)
- [3. 获取本仓库](#3-获取本仓库)
- [4. 方式 A：命令行一键安装](#4-方式-a命令行一键安装)
- [5. 方式 B：图形界面安装（通用）](#5-方式-b图形界面安装通用)
- [6. 配置火山引擎凭据](#6-配置火山引擎凭据)
- [7. 验证安装](#7-验证安装)
- [8. 更新插件](#8-更新插件)
- [9. 卸载](#9-卸载)
- [10. 平台差异与已知事项](#10-平台差异与已知事项)

---

## 1. 前置条件

| 项 | 要求 | 检查方法 |
|---|---|---|
| ZCode 桌面端 | 任意近期版本（插件系统 = MCP Apps） | 能正常打开会话即可 |
| Node.js | **≥ 22**（插件 MCP 服务器使用全局 WebSocket） | `node --version` |
| 操作系统 | Windows 10/11 或 Ubuntu 20.04+（其他 Linux 桌面同理） | — |
| 麦克风 | 系统可用录音设备 | 系统设置 |

Ubuntu 安装 Node.js ≥ 22（任选其一）：

```bash
# nvm（推荐，无需 root）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install 22 && nvm use 22

# 或 NodeSource（apt）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

> 说明：插件运行时零 npm 依赖；Node 只用于运行插件的 MCP 服务器进程（ZCode 会在启动插件时以 `node` 命令拉起它）。开发/测试另行需要 `npm install`。

## 2. 环境体检

```bash
cd zcode-voice-input
node scripts/doctor.mjs
```

体检项：Node 版本 ≥ 22、能否定位 ZCode CLI（Windows/Linux 常见安装路径 + `ZCODE_CLI` 环境变量）、插件清单是否通过官方结构校验、面板构建产物是否最新。全部通过即可进入下一步；任何一项失败脚本会给出对应处理建议。

## 3. 获取本仓库

```bash
git clone <本仓库地址> zcode-voice-input
cd zcode-voice-input
```

（或下载 Release 中的源码包。）

## 4. 方式 A：命令行一键安装

```bash
node scripts/install-local.mjs
```

脚本依次执行：构建面板 → 构建本地市场（`dist/local-marketplace`）→ 注册本地市场 → 安装并启用插件 → 打印安装结果。

- ZCode CLI 定位顺序：`--zcode <路径>` 参数 → `ZCODE_CLI` 环境变量 → 常见安装位置自动搜索
  （Windows：`C:\Program Files\ZCode`、`%LOCALAPPDATA%\Programs\ZCode`、其他盘符；Linux：`/usr/share/zcode`、`/opt/*`、`~/.local/share`、AppImage 挂载点等）。
- 也可显式指定：`node scripts/install-local.mjs --zcode "/usr/share/zcode/resources/glm/zcode.cjs"`
- 需要 `--skip-build` 跳过构建（已构建过时）。

成功输出示例：

```
Added marketplace dev-zcode-voice-input-local (1 plugins)
Installed plugin zcode-voice-input@dev-zcode-voice-input-local (0.1.0) [enabled]
Enabled plugin zcode-voice-input@dev-zcode-voice-input-local in .../config.json
```

## 5. 方式 B：图形界面安装（通用）

1. 若尚未构建：`node scripts/build-package.mjs`（生成 `dist/local-marketplace`）。
2. 打开 ZCode → 左下 **设置/插件市场** → **插件市场 → 添加 → 添加插件市场**。
3. 粘贴本仓库 `dist/local-marketplace` 目录的**绝对路径**并确认
   - Windows 例：`G:\path\to\zcode-voice-input\dist\local-marketplace`
   - Ubuntu 例：`/home/<你>/zcode-voice-input/dist/local-marketplace`
4. 进入市场 **dev-zcode-voice-input-local** → 插件 **ZCode Voice Input / 语音输入** → **安装** → 如有启用开关则**启用**。
5. **完全退出并重启 ZCode**（托盘退出，不是仅关窗口）。

## 6. 配置火山引擎凭据

> **入口在插件详情页的"高级信息"里**，不是列表页的直接按钮，按下面路径点：

1. ZCode → **设置** → **插件**。
2. 在**已安装插件列表**中点击 **ZCode Voice Input（语音输入）**，打开插件**详情页**。
3. 在详情页展开 **「高级信息」**（More details）。
4. 展开 区块内的 **「配置」** 部分即凭据填写处，二选一：
   - 新版语音控制台：**App Key**（请求头 `X-Api-Key`）
   - 旧版语音控制台：**App ID** + **Access Token**（敏感字段，带"显示密钥"切换与"清除已保存密钥"按钮）
5. （可选）资源 ID：默认 `volc.seedasr.sauc.duration`（豆包流式语音识别 2.0 · 按时长计费）；并发计费可改 `volc.seedasr.sauc.concurrent`。
6. 点击 **「保存配置」**，然后**完全退出并重启 ZCode**（或新开会话）使环境变量注入生效。

找不到「配置」区块？逐项检查：插件是否已**启用**；安装后是否**重启过 ZCode**；
是否点进了插件**详情页**（列表页只有安装/启用/卸载按钮，配置在详情页「高级信息」内）。

凭据仅注入插件 MCP 服务器进程环境变量，不落盘到面板/日志/仓库。未配置时插件为 Mock 演示模式（面板与 `voice_status` 工具均会明确标注）。

## 7. 验证安装

```bash
node "<ZCode安装目录>/resources/glm/zcode.cjs" plugins list --json
```

应看到 `zcode-voice-input@dev-zcode-voice-input-local` 且 `"enabled": true`。

界面验证：重启 ZCode → 新开会话 → 工具栏/插件入口出现 **语音输入** 面板 → 点击 🎤 首次录音按提示允许麦克风 → 说话 → ⏹ 停止后出字。

## 7.5（推荐）安装输入法式录音条

对话内面板之外，v0.2.0 提供吸附在输入框旁的常驻录音条（按住 `F8` 说话、松开直插输入框）。
它需要给客户端 `app.asar` 追加一行注入（与 `zcode-token-usage-statusbar` 同机制，已在同客户端验证可加载）：

```bash
node scripts/install-overlay.mjs           # 安装（幂等）
node scripts/install-overlay.mjs status    # 查看注入状态
node scripts/install-overlay.mjs uninstall # 卸载（仅剥离本插件注入行）
```

- ZCode **运行中**安装时：脚本生成待替换包并派生后台进程，**完全退出 ZCode（托盘右键退出）后自动完成替换**，之后重开即可。
  **后台进程最多等待 2 小时**：超时即放弃并**自动删除**待替换包（表现：`status` 显示"未安装"）。
  所以装完请**尽快完全退出并重启一次**；不要装完就搁置。
- 若提示无权限写入安装目录：用**管理员**终端重跑同一条命令。
- 插件自身升级/重装**不影响**注入（overlay 运行目录独立于插件缓存）。
- ZCode 官方升级覆盖 `app.asar` 后注入会失效：重跑 install 命令再重启即可。
- 不想改客户端就跳过本步，对话内面板功能完整不受影响。

## 8. 更新插件

拉取新代码后：

```bash
git pull
node scripts/install-local.mjs          # 重新构建并安装
```

或图形界面：插件市场 → 本市场 → 刷新 → 更新。

## 9. 卸载

```bash
node scripts/uninstall.mjs              # 卸载插件
node scripts/uninstall.mjs --remove-market   # 同时移除本地市场注册
```

或图形界面：设置 → 插件 → ZCode Voice Input → 卸载。

## 10. 平台差异与已知事项

| 项 | Windows | Ubuntu |
|---|---|---|
| 安装验证 | ✅ 已实测（安装/启用/禁用/卸载/重装全生命周期） | ✅ CI 在 ubuntu-latest 跑完整测试套件；本机安装流程同 Windows（自动发现路径已覆盖） |
| 麦克风采集 | Chromium/WASAPI | Chromium/PipeWire-PulseAudio；首次可能需要在系统"隐私/声音"设置里允许桌面应用录音 |
| 粘贴到输入框 | Ctrl+V | Ctrl+V（X11/Wayland 下 ZCode 内部输入框行为一致） |
| zcode CLI 位置 | `<盘>:\Program Files\ZCode\resources\glm\zcode.cjs` 或 `%LOCALAPPDATA%\Programs\ZCode\...` | `/usr/share/zcode/resources/glm/zcode.cjs`、`/opt/...`、AppImage 内（见 doctor 输出） |
| 全局快捷键 | 未实现（宿主无对应 API） | 同左 |

其余限制见根目录 [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md)。
