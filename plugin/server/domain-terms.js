// domain-terms.js — 内置领域词库（热词 + 错词纠正变体）
// 原则：
//  1. 火山双向流式（sentence 模式）热词上限 100 个：内置词合计控制在 90 以内，
//     给个人词典（dictionary.json）预留至少 10 个热词名额。
//  2. 数组顺序 = 热词注入优先级（超限时靠前的词先被保留）：矿山安全监测 > 测绘 > 遥感 > GIS > 计算机。
//  3. word = 标准写法（进热词 + 纠正目标）；match = 常见同音/近音错认变体，仅用于
//     postProcess 整词精确替换（不占热词名额）。match 只收录"非正常词汇"的错认形态，
//     避免把正常普通词误替换成术语。
'use strict';

// 矿山安全在线监测（尾矿库/边坡/坝体监测预警）
const MINING_SAFETY_TERMS = [
  { word: '浸润线', match: ['金瑞线', '进润线', '金润线', '金锐线', '今润线'] },
  { word: '浸润线埋深' },
  { word: '测斜孔', match: ['测线孔', '侧斜孔', '测细孔', '测斜控'] },
  { word: '尾矿库', match: ['卫矿库', '位矿库'] },
  { word: '干滩', match: ['干摊', '甘滩'] },
  { word: '干滩长度', match: ['干摊长度', '甘滩长度'] },
  { word: '库水位' },
  { word: '坝体' },
  { word: '初期坝' },
  { word: '堆积坝' },
  { word: '副坝' },
  { word: '溢洪道' },
  { word: '排洪井' },
  { word: '排水井' },
  { word: '渗流监测', match: ['盛流监测'] },
  { word: '渗压计', match: ['声压计', '渗压记'] }, // 注：声压计为声学仪器名，本插件面向矿山/测绘场景，按近音纠正
  { word: '渗流量' },
  { word: '测压管' },
  { word: '孔隙水压力' },
  { word: '土压力计' },
  { word: '量水堰', match: ['量水眼', '量水宴'] },
  { word: '表面位移' },
  { word: '内部位移' },
  { word: '位移监测' },
  { word: '裂缝监测', match: ['列缝监测'] },
  { word: '沉降监测' },
  { word: '应力应变' },
  { word: '采空区', match: ['采控区'] },
  { word: '边坡稳定性' },
  { word: '监测预警' },
  { word: '报警阈值', match: ['报警域值', '报警阀值'] },
  { word: '阈值', match: ['域值', '阀值', '预值'] },
  { word: '预警等级' },
  { word: '应急预案' },
  { word: '隐患排查' },
  { word: '无人值守' },
  { word: '在线监测' },
  { word: '安全监测' },
];

// 测绘
const SURVEYING_TERMS = [
  { word: '全站仪', match: ['全站一'] },
  { word: '水准仪', match: ['水准一'] },
  { word: 'RTK', match: ['rtk', 'r t k'] },
  { word: 'GNSS接收机' },
  { word: '控制点' },
  { word: '像控点', match: ['相控点', '向控点'] },
  { word: '空中三角测量' },
  { word: '正射影像', match: ['正摄影像'] },
  { word: '数字高程模型' },
  { word: '数字线划图', match: ['数字线画图'] },
  { word: '等高线' },
  { word: '地籍测量' },
  { word: '工程测量' },
  { word: '变形监测', match: ['边形监测'] },
  { word: '沉降观测' },
  { word: '坐标转换' },
  { word: 'CGCS2000', match: ['cgcs2000'] },
  { word: '似大地水准面' },
];

// 遥感
const REMOTE_SENSING_TERMS = [
  { word: '遥感影像' },
  { word: '合成孔径雷达', match: ['合成孔经雷达'] },
  { word: '时序InSAR', match: ['时序insar'] },
  { word: 'InSAR', match: ['insar'] },
  { word: '多光谱' },
  { word: '高光谱' },
  { word: '遥感解译' },
  { word: '辐射定标' },
  { word: '大气校正', match: ['大气较正'] },
  { word: '归一化植被指数' },
  { word: '变化检测' },
  { word: '地表覆盖', match: ['地表复盖'] },
];

// 地理信息
const GIS_TERMS = [
  { word: '地理信息系统' },
  { word: '空间数据库' },
  { word: '矢量数据', match: ['失量数据'] },
  { word: '栅格数据' },
  { word: '空间分析' },
  { word: '地图投影' },
  { word: '空间索引' },
  { word: 'WebGIS', match: ['webgis', 'web gis'] },
  { word: '拓扑关系', match: ['拓朴关系', '托普关系'] },
];

// 计算机（保留识别易错的长尾术语；Java/Git/API/JSON/SQL 等通用词大模型本身识别良好，让位给领域词）
const CS_TERMS = [
  { word: 'Spring Boot', match: ['springboot', 'spring boot', 'springboot框架'] },
  { word: 'MyBatis', match: ['mybatis', 'my batis', '麦batis'] },
  { word: 'openGauss', match: ['opengauss', 'open gauss', '欧朋gauss', 'open高斯'] },
  { word: 'PostgreSQL', match: ['postgresql', 'postgre sql', 'postgressql', '泡斯格q'] },
  { word: 'Vue', match: ['vue'] },
  { word: 'JavaScript', match: ['javascript', 'java script', 'java脚本'] },
  { word: 'TypeScript', match: ['typescript', 'type script', 'types脚本'] },
  { word: 'MQTT', match: ['mqtt'] },
  { word: 'GNSS', match: ['gnss'] },
  { word: 'Cesium', match: ['cesium', 'esium'] },
  { word: 'Docker', match: ['docker'] },
  { word: 'GitHub', match: ['github', 'git hub'] },
  { word: 'WebSocket', match: ['websocket', 'web socket', '网路socket'] },
];

module.exports = {
  MINING_SAFETY_TERMS,
  SURVEYING_TERMS,
  REMOTE_SENSING_TERMS,
  GIS_TERMS,
  CS_TERMS,
};
