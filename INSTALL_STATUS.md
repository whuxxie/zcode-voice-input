# INSTALL_STATUS — 安装状态（如实记录）

更新时间：2026-10-28

## 当前状态：✅ 已在当前 ZCode 桌面端实际安装并启用（待重启后人工打开面板确认）

## 实际执行记录（CLI 真实输出摘录）

```
$ zcode plugins marketplace add G:\xxie\zcode-voice-input\dist\local-marketplace --scope user
Added marketplace dev-zcode-voice-input-local (1 plugins)

$ zcode plugins install zcode-voice-input@dev-zcode-voice-input-local --scope user
Installed plugin zcode-voice-input@dev-zcode-voice-input-local (0.1.0) [enabled]

$ zcode plugins enable zcode-voice-input@dev-zcode-voice-input-local --scope user
Enabled plugin zcode-voice-input@dev-zcode-voice-input-local in C:\Users\whuxxie\.zcode\cli\config.json
```

`zcode plugins list --json` 中的实际条目：

```json
{
  "id": "zcode-voice-input@dev-zcode-voice-input-local",
  "enabled": true,
  "manifestPath": "C:\\Users\\whuxxie\\.zcode\\cli\\plugins\\cache\\dev-zcode-voice-input-local\\zcode-voice-input\\0.1.0\\.zcode-plugin\\plugin.json",
  "declaredMcpServerNames": ["voice-input"],
  "mcpServerNames": ["plugin:zcode-voice-input:voice-input"],
  "skillCount": 1,
  "diagnostics": [],
  "version": "0.1.0"
}
```

官方校验：`zcode plugins validate plugin` → `Plugin manifest is valid`

## 生命周期实测（真实 CLI 循环）

| 操作 | 结果 |
|---|---|
| disable | ✅ enabled:false（config.json 记录） |
| enable | ✅ enabled:true |
| uninstall --force | ✅ 从已安装列表移除 |
| 重新 install+enable | ✅ present:true enabled:true（当前状态） |

## 用户侧还需要的手工步骤（最少）

1. **完全退出并重启 ZCode 桌面端**（桌面端启动时加载插件注册表）。
2. 新开一个会话 → 工具栏/插件入口中打开 **"语音输入"** 面板。
3. 首次点击 🎤 时允许**浏览器麦克风授权**（沙箱内弹窗）与**系统授权提示**。
4. （可选但建议）配置火山引擎凭据（新版控制台 App Key，或旧版 App ID + Access Token）。
   **入口：设置 → 插件 → 点击"语音输入"进入详情页 → 展开「高级信息」→「配置」→ 填写 →「保存配置」→ 重启 ZCode。**
   未配置时为 Mock 演示模式。
5. 说一段话 → ⏹ 停止 → 检查/编辑文字 → 📥 复制并准备粘贴 → 点聊天输入框 Ctrl+V → 自行 Enter 发送。

## 安装产物位置

- 源码：`G:\xxie\zcode-voice-input\plugin\`
- 本地市场：`G:\xxie\zcode-voice-input\dist\local-marketplace\`（marketplace.json + plugins/zcode-voice-input）
- 分发包：`G:\xxie\zcode-voice-input\dist\zcode-voice-input-v0.1.0.zip`（sha256 见同名 .sha256 文件）
- 已安装缓存：`C:\Users\whuxxie\.zcode\cli\plugins\cache\dev-zcode-voice-input-local\zcode-voice-input\0.1.0\`
- 插件数据目录：`C:\Users\whuxxie\.zcode\cli\plugins\data\zcode-voice-input@dev-zcode-voice-input-local`

## 卸载方式

- 图形界面：设置 → 插件 → ZCode Voice Input → 卸载
- 命令行：`node scripts/uninstall.mjs [--remove-market]`
- 实测命令：`zcode plugins uninstall zcode-voice-input@dev-zcode-voice-input-local --scope user --force`（已验证有效）
