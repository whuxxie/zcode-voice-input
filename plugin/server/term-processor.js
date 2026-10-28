// term-processor.js — 面向程序员的中英文术语处理
// 原则：
//  1. 优先使用火山引擎官方机制：热词注入 (corpus.context) 与自学习平台表 id（如用户配置）。
//  2. 后处理默认保守：只做"整词大小写规范化"（仅当识别结果中存在该词的小写/变体形式且词典声明 protectCase），
//     绝不把普通词替换成技术名词（那类纠错交给热词，由 ASR 引擎在识别阶段使用）。
//  3. 不修改代码变量名、路径、端口、SQL、命令参数：后处理只在"整词边界 + 与词典精确匹配"时生效。
'use strict';

// 内置术语表：word = 希望显示的标准写法；match = 可匹配的常见识别变体（小写比较）
const BUILTIN_TERMS = [
  { word: 'Spring Boot', match: ['springboot', 'spring boot', 'springboot框架'] },
  { word: 'MyBatis', match: ['mybatis', 'my batis', '麦batis'] },
  { word: 'openGauss', match: ['opengauss', 'open gauss', '欧朋gauss', 'open高斯'] },
  { word: 'PostgreSQL', match: ['postgresql', 'postgre sql', 'postgressql', '泡斯格q'] },
  { word: 'Vue', match: ['vue'] },
  { word: 'Java', match: ['java'] },
  { word: 'JavaScript', match: ['javascript', 'java script', 'java脚本'] },
  { word: 'TypeScript', match: ['typescript', 'type script', 'types脚本'] },
  { word: 'MQTT', match: ['mqtt'] },
  { word: 'GNSS', match: ['gnss'] },
  { word: 'Cesium', match: ['cesium', 'esium'] },
  { word: 'Docker', match: ['docker'] },
  { word: 'Git', match: ['git'] },
  { word: 'GitHub', match: ['github', 'git hub'] },
  { word: 'API', match: ['api', 'a p i'] },
  { word: 'JSON', match: ['json', 'j son'] },
  { word: 'SQL', match: ['sql', 's q l'] },
  { word: 'WebSocket', match: ['websocket', 'web socket', '网路socket'] },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 构造整词边界正则。中文两侧不加边界（中文无词边界概念），英数两侧要求边界。 */
function buildWordRegex(term) {
  const body = escapeRegExp(term);
  if (/^[A-Za-z0-9+\-#.\s]+$/.test(term)) {
    return new RegExp(`(?<![A-Za-z0-9_])(${body})(?![A-Za-z0-9_])`, 'gi');
  }
  return new RegExp(`(${body})`, 'gi');
}

function makeReplacer(entries) {
  // entries: [{word, match[]}] — 按 word 长度降序避免短词先替换破坏长词
  const sorted = [...entries].sort((a, b) => b.word.length - a.word.length);
  const rules = [];
  for (const e of sorted) {
    const variants = new Set([e.word, ...(e.match || [])]);
    for (const v of variants) {
      if (v.toLowerCase() === e.word.toLowerCase() && v === e.word) continue; // 原词自身无需替换
      rules.push({ re: buildWordRegex(v), word: e.word, variant: v });
    }
  }
  return function replace(text) {
    let out = text;
    for (const r of rules) {
      out = out.replace(r.re, (m, ...args) => {
        // 整词匹配时替换为标准写法；保留原词大小写场景交给 ASR 热词处理
        return r.word;
      });
    }
    return out;
  };
}

/** 温和的标点规整：压缩连续重复标点、补全结尾句号（仅中英文语境）。 */
function normalizePunctuation(text, { addFinalPunctuation = true } = {}) {
  let out = text.replace(/([，。！？、,.!?])\1{1,}/g, '$1');
  out = out.replace(/\s+([，。！？,.!?])/g, '$1');
  if (addFinalPunctuation && out.length > 0 && !/[。！？!?.…，,]$/.test(out)) {
    out = out + '。';
  }
  return out;
}

/** 清理明显口头重复："那个那个" → "那个"；"the the" → "the"。仅针对相邻重复的 1-3 字词。 */
function cleanStutters(text) {
  return text.replace(/([\u4e00-\u9fa5]{1,3}|[A-Za-z]{2,8})(\s*)(\1)(\2\1)*/g, '$1');
}

/**
 * 应用后处理。
 * options:
 *  - dictionary: 用户自定义词条 [{word, match?[]}]
 *  - addPunctuation: 结尾补标点（默认 false，尊重原始识别结果）
 *  - cleanRepeat: 清理口头重复（默认 false）
 *  - applyCaseFix: 应用内置/自定义整词规范写法（默认 false —— 默认只依赖 ASR 热词）
 */
function postProcess(text, options = {}) {
  const {
    dictionary = [],
    addPunctuation = false,
    cleanRepeat = false,
    applyCaseFix = false,
  } = options;
  let out = text;
  if (applyCaseFix) {
    const entries = [...BUILTIN_TERMS, ...dictionary];
    out = makeReplacer(entries)(out);
  }
  if (cleanRepeat) out = cleanStutters(out);
  if (addPunctuation) out = normalizePunctuation(out);
  return out;
}

/** 生成热词列表（用于 corpus.context）。去重、限长、限量。 */
function hotwordList({ dictionary = [], includeBuiltin = true, limit = 100 } = {}) {
  const words = [];
  const seen = new Set();
  const push = (w) => {
    if (typeof w !== 'string') return;
    const t = w.trim();
    if (!t || t.length > 30) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    words.push(t);
  };
  if (includeBuiltin) for (const t of BUILTIN_TERMS) push(t.word);
  for (const d of dictionary) push(typeof d === 'string' ? d : d && d.word);
  return words.slice(0, limit);
}

/** 日志脱敏：遮蔽疑似密钥的字符串。 */
function redactSecrets(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/(X-Api-Access-Key|X-Api-App-Key|X-Api-Key|Authorization|access[_-]?token|api[_-]?key|app[_-]?id)(\s*[:=]\s*)(\S+)/gi,
      (_m, a, b) => `${a}${b}***`)
    .replace(/\b([A-Za-z0-9+/_-]{32,})(={0,2})\b/g, '***redacted***');
}

module.exports = { BUILTIN_TERMS, postProcess, hotwordList, normalizePunctuation, cleanStutters, redactSecrets };
