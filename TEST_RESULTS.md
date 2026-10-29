# TEST_RESULTS — ZCode Voice Input

> 记录每次自动化测试的实际执行结果（命令 + 输出摘要 + 结论）。禁止只写"建议人工测试"。

## 约定
状态枚举：PASS / FAIL / BLOCKED(缺凭据或图形授权) / NOT-RUN

## 结果

（尚未执行）

## 必须人工验证项（与自动化区分）
1. 真实麦克风拾音与 PipeWire 路由（需用户在场说话）
2. 火山引擎真实 API 联通（需用户在插件设置填入 AppID/AccessToken）
3. ZCode 宿主内麦克风授权弹窗点击（图形界面操作）
4. 实际把文字放入 ZCode 聊天输入框后的发送体验
