#!/usr/bin/env bash
# fix-overlay-path.sh — 修复 ZCode app.asar 中语音输入 overlay 的错误加载路径
#
# 问题：app.asar 入口尾部追加的加载语句指向
#       file:///root/.zcode/zcode-voice-input/inject-main.cjs（打补丁时误用了 root 家目录），
#       而 ZCode 以 whuxxie 用户运行、/root 权限为 0700 不可读 →
#       注入器加载失败 → 输入框旁的 🎤 录音条和 F8 等全局快捷键全部不生效。
#
# 方案：53 字节等长原位替换为指向 /home/whuxxie/vi.cjs 的 URL（带 /./ 冗余段凑长度，
#       WHATWG URL 规范化会折叠掉，加载结果不变）；vi.cjs 是指向
#       ~/.zcode/zcode-voice-input/inject-main.cjs 的软链。等长替换不移动 asar
#       内任何偏移，安全且可回滚。
#
# 用法：sudo bash fix-overlay-path.sh
#       然后完全退出 ZCode（托盘右键 → 退出，不是只关窗口）并重新打开。
# 回滚：sudo cp /opt/ZCode/resources/app.asar.bak-voice /opt/ZCode/resources/app.asar
set -euo pipefail

ASAR=/opt/ZCode/resources/app.asar
LNK=/home/whuxxie/vi.cjs

# 0) 确保软链存在（幂等；脚本以 root 运行时也强制归属 whuxxie 家目录）
if [ ! -e "$LNK" ]; then
  ln -sfn /home/whuxxie/.zcode/zcode-voice-input/inject-main.cjs "$LNK"
fi

# 1) 首次运行先备份
if [ ! -e "$ASAR.bak-voice" ]; then
  cp "$ASAR" "$ASAR.bak-voice"
  echo "已备份 → $ASAR.bak-voice"
fi

# 2) 等长替换（53 字节 → 53 字节，不动 asar 偏移）
python3 - <<'PY'
p = '/opt/ZCode/resources/app.asar'
old = b'file:///root/.zcode/zcode-voice-input/inject-main.cjs'
new = b'file:///home/whuxxie' + b'/.' * 13 + b'/vi.cjs'
assert len(old) == len(new), (len(old), len(new))

f = open(p, 'r+b')
d = f.read()
i = d.find(old)
if i == -1:
    assert d.find(new) != -1, '找不到目标行：asar 内容与预期不符，未做任何修改'
    print('已经是修复后的状态，无需修改')
else:
    assert d.find(old, i + 1) == -1, '出现多处匹配，为安全起见放弃修改'
    f.seek(i)
    f.write(new)
    print('已修复：偏移 %d，替换为指向 /home/whuxxie/vi.cjs 的等长 URL' % i)
f.close()
PY

echo
echo '完成。请完全退出 ZCode（托盘右键→退出）后重新打开，'
echo '聊天输入框右上角应出现 🎤 录音按钮。'
echo '快捷键：按住 F8 说话、松开插入；Ctrl+Shift+Space 开关；录音中 Esc 取消。'
echo '注意：ZCode 自动更新会整体替换 app.asar，更新后如按钮消失，重跑本脚本即可。'
