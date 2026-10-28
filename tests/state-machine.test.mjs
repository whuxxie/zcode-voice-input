// 测试 11（自动化部分）：面板录音状态机 — 防并发、迁移合法性
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// state-machine.js 为三种上下文通用的纯源码（无模块系统语句），用受控求值加载
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../plugin/panel/src/state-machine.js'), 'utf8');
const { STATES, canStart, canStop, canCancel, canUseResult, canTransition } = new Function(
  `${src}; return { STATES, canStart, canStop, canCancel, canUseResult, canTransition };`
)();

test('idle/done/error 可开始录音，starting/recording/processing 不可（防并发会话）', () => {
  assert.equal(canStart(STATES.IDLE), true);
  assert.equal(canStart(STATES.DONE), true);
  assert.equal(canStart(STATES.ERROR), true);
  assert.equal(canStart(STATES.STARTING), false);
  assert.equal(canStart(STATES.RECORDING), false);
  assert.equal(canStart(STATES.PROCESSING), false);
});

test('仅 recording 可停止', () => {
  assert.equal(canStop(STATES.RECORDING), true);
  for (const s of Object.values(STATES)) if (s !== STATES.RECORDING) assert.equal(canStop(s), false, s);
});

test('starting/recording/processing 可取消', () => {
  assert.equal(canCancel(STATES.STARTING), true);
  assert.equal(canCancel(STATES.RECORDING), true);
  assert.equal(canCancel(STATES.PROCESSING), true);
  assert.equal(canCancel(STATES.IDLE), false);
  assert.equal(canCancel(STATES.DONE), false);
});

test('仅 done 可使用结果（复制/插入）', () => {
  assert.equal(canUseResult(STATES.DONE), true);
  assert.equal(canUseResult(STATES.RECORDING), false);
});

test('迁移表覆盖全部合法事件路径', () => {
  assert.ok(canTransition(STATES.IDLE, STATES.STARTING));
  assert.ok(canTransition(STATES.STARTING, STATES.RECORDING));
  assert.ok(canTransition(STATES.RECORDING, STATES.PROCESSING));
  assert.ok(canTransition(STATES.PROCESSING, STATES.DONE));
  assert.ok(canTransition(STATES.RECORDING, STATES.IDLE)); // 取消
  assert.ok(canTransition(STATES.PROCESSING, STATES.ERROR));
  assert.ok(canTransition(STATES.DONE, STATES.STARTING)); // 重新录音
  // 非法：recording 直接到 done（必须经 stop → processing → final）
  assert.ok(!canTransition(STATES.RECORDING, STATES.DONE));
});
