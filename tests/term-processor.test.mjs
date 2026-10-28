// 测试 9/10：术语处理（热词、整词规范、口头重复、标点）与日志脱敏
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TERMS, postProcess, hotwordList, normalizePunctuation, cleanStutters, redactSecrets } from '../plugin/server/term-processor.js';

test('内置术语表包含规约要求的全部术语', () => {
  const words = BUILTIN_TERMS.map((t) => t.word);
  for (const w of ['Spring Boot', 'MyBatis', 'openGauss', 'PostgreSQL', 'Vue', 'Java', 'JavaScript',
    'TypeScript', 'MQTT', 'GNSS', 'Cesium', 'Docker', 'Git', 'GitHub', 'API', 'JSON', 'SQL', 'WebSocket']) {
    assert.ok(words.includes(w), `缺少术语 ${w}`);
  }
});

test('整词规范：springboot → Spring Boot，且不动普通词', () => {
  const out = postProcess('用springboot写一个接口，连接opengauss数据库', { applyCaseFix: true });
  assert.ok(out.includes('Spring Boot'));
  assert.ok(out.includes('openGauss'));
  // 不把普通中文词替换成技术名词
  const out2 = postProcess('今天天气很好', { applyCaseFix: true });
  assert.equal(out2, '今天天气很好');
});

test('整词边界：不破坏变量名', () => {
  const out = postProcess('变量springboot2保持原样', { applyCaseFix: true });
  // 中文紧邻英文：按设计中文邻接仍允许替换词本身，但完整变量 springboot2 不被切开
  assert.ok(!out.includes('Spring Boot2'), '不应替换为 Spring Boot2（变量名后缀数字保持）');
});

test('JSON/SQL/GitHub 大小写变体', () => {
  const out = postProcess('把json转成sql上传到github', { applyCaseFix: true });
  assert.ok(out.includes('JSON'));
  assert.ok(out.includes('SQL'));
  assert.ok(out.includes('GitHub'));
});

test('cleanStutters 只清相邻重复', () => {
  assert.equal(cleanStutters('那个那个那个方案'), '那个方案');
  assert.equal(cleanStutters('the the code'), 'the code');
  assert.equal(cleanStutters('并发并发处理'), '并发处理');
  // 不清除非相邻
  assert.equal(cleanStutters('那个和那个'), '那个和那个');
});

test('normalizePunctuation 压缩重复标点并补尾标点', () => {
  assert.equal(normalizePunctuation('好的！！'), '好的！');
  assert.equal(normalizePunctuation('结束'), '结束。');
  assert.equal(normalizePunctuation('完成。', { addFinalPunctuation: true }), '完成。');
});

test('postProcess 默认保守：不改原文', () => {
  assert.equal(postProcess('springboot很好！！那个那个'), 'springboot很好！！那个那个');
});

test('hotwordList：去重、内置+自定义、限量', () => {
  const list = hotwordList({ dictionary: ['Vue', { word: 'openGauss' }], includeBuiltin: true });
  assert.ok(list.includes('Spring Boot'));
  assert.ok(list.includes('Vue'));
  assert.equal(list.filter((w) => w === 'Vue').length, 1);
  const capped = hotwordList({ dictionary: Array.from({ length: 150 }, (_, i) => `词${i}`), includeBuiltin: false, limit: 100 });
  assert.equal(capped.length, 100);
});

test('redactSecrets：遮蔽密钥形态字符串与赋值', () => {
  const s = redactSecrets('X-Api-Access-Key: abcdef123456 and access_token=zzzzzz');
  assert.ok(!s.includes('abcdef123456'));
  assert.ok(s.includes('***'));
  const long = redactSecrets('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcd');
  assert.ok(!long.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcd'));
});

test('长 token 被脱敏（>=32 字符）', () => {
  const t = 'a'.repeat(40);
  assert.ok(redactSecrets(`secret ${t}`).includes('***'));
  const short = 'hello world, this is fine';
  assert.equal(redactSecrets(short), short);
});
