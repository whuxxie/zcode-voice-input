// state-machine.js — 面板录音状态机（纯函数；浏览器内联运行，Node 测试经求值加载）
// 注意：本文件不得使用 import/export/module.exports（三种上下文通用）。
'use strict';

const STATES = { IDLE: 'idle', STARTING: 'starting', RECORDING: 'recording', PROCESSING: 'processing', DONE: 'done', ERROR: 'error' };

function canStart(state) {
  return state === STATES.IDLE || state === STATES.DONE || state === STATES.ERROR;
}
function canStop(state) {
  return state === STATES.RECORDING;
}
function canCancel(state) {
  return state === STATES.RECORDING || state === STATES.PROCESSING || state === STATES.STARTING;
}
function canUseResult(state) {
  return state === STATES.DONE;
}
/** 状态迁移合法性（防御性：UI 只应按事件表迁移） */
const TRANSITIONS = {
  [STATES.IDLE]: [STATES.STARTING, STATES.DONE, STATES.ERROR, STATES.IDLE],
  [STATES.STARTING]: [STATES.RECORDING, STATES.ERROR, STATES.IDLE],
  [STATES.RECORDING]: [STATES.PROCESSING, STATES.IDLE, STATES.ERROR],
  [STATES.PROCESSING]: [STATES.DONE, STATES.IDLE, STATES.ERROR],
  [STATES.DONE]: [STATES.STARTING, STATES.IDLE, STATES.ERROR],
  [STATES.ERROR]: [STATES.STARTING, STATES.IDLE, STATES.DONE],
};
function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}
