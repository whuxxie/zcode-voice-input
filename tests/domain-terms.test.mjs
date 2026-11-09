// 测试：内置领域词库结构校验（热词预算、去重、变体合法性）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MINING_SAFETY_TERMS,
  SURVEYING_TERMS,
  REMOTE_SENSING_TERMS,
  GIS_TERMS,
  CS_TERMS,
} from '../plugin/server/domain-terms.js';
import { BUILTIN_TERMS } from '../plugin/server/term-processor.js';

const GROUPS = {
  矿山安全监测: MINING_SAFETY_TERMS,
  测绘: SURVEYING_TERMS,
  遥感: REMOTE_SENSING_TERMS,
  地理信息: GIS_TERMS,
  计算机: CS_TERMS,
};

test('词条结构合法：word 非空、≤30 字符、match 为非空字符串数组', () => {
  for (const [name, terms] of Object.entries(GROUPS)) {
    for (const t of terms) {
      assert.ok(t && typeof t.word === 'string' && t.word.trim().length > 0, `${name}: word 非法 ${JSON.stringify(t)}`);
      assert.ok(t.word.length <= 30, `${name}: word 超长 "${t.word}"`);
      if (t.match !== undefined) {
        assert.ok(Array.isArray(t.match), `${name}: match 必须为数组 (${t.word})`);
        for (const m of t.match) {
          assert.ok(typeof m === 'string' && m.trim().length > 0, `${name}: match 变体非法 (${t.word} <- ${JSON.stringify(m)})`);
          assert.ok(m.length <= 30, `${name}: match 变体超长 (${m})`);
        }
      }
    }
  }
});

test('word 全局唯一（跨类别不重复）', () => {
  const seen = new Set();
  for (const terms of Object.values(GROUPS)) {
    for (const t of terms) {
      const k = t.word.toLowerCase();
      assert.ok(!seen.has(k), `重复词条: ${t.word}`);
      seen.add(k);
    }
  }
});

test('match 变体不等于 word 本身且组内不重复', () => {
  for (const terms of Object.values(GROUPS)) {
    for (const t of terms) {
      const lower = t.word.toLowerCase();
      for (const m of t.match || []) {
        assert.ok(m.toLowerCase() !== lower || m !== t.word, `match 与 word 完全相同 (${t.word})`);
      }
      const set = new Set((t.match || []).map((m) => m.toLowerCase()));
      assert.equal(set.size, (t.match || []).length, `match 变体重复 (${t.word})`);
    }
  }
});

test('热词预算：内置词总数 ≤90，给个人词典留 ≥10 个名额（火山上限 100）', () => {
  const total = Object.values(GROUPS).reduce((n, terms) => n + terms.length, 0);
  assert.ok(total <= 90, `内置词条总数 ${total} 超预算`);
  assert.equal(BUILTIN_TERMS.length, total, 'BUILTIN_TERMS 应等于各领域词之和');
});

test('矿山安全监测词排在最前（热词截断时保最高优先级）', () => {
  for (let i = 0; i < MINING_SAFETY_TERMS.length; i++) {
    assert.equal(BUILTIN_TERMS[i], MINING_SAFETY_TERMS[i], `第 ${i} 位应为矿山词`);
  }
  assert.equal(BUILTIN_TERMS[0].word, '浸润线');
});
