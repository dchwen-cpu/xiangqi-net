// trading.js —— 观澜台:立山斋 → SPYQ 交易世界(公众只读 + 属主全权)
//   挂载: app.use('/api/trading', require('./trading'));
//   公众面板(只读浏览): TRADING_PANELS_PUBLIC  JSON 数组,如:
//     [{"label":"纸面日记","url":"https://spyq-station.onrender.com/spyq"},
//      {"label":"实况","url":"https://spyq-station.onrender.com/live"}]
//   属主追加面板(登录且=OWNER 才下发,如控制台): TRADING_PANELS
//   安全边界: 修改类操作全部由纸面站自身的控制台口令把守;此处只分发地址。
//   非属主请求 /portal 一律 404(隐身)。

const express = require('express');
const { authRequired } = require('./auth');

const router = express.Router();
const OWNER = process.env.OWNER_USERNAME || '';

function parsePanels(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[trading] 面板环境变量不是合法 JSON,已忽略');
    return [];
  }
}

// 公众面板(无需登录;只读页面)
router.get('/public', (_req, res) => {
  let pub = parsePanels(process.env.TRADING_PANELS_PUBLIC);
  if (!pub.length) {                       // 向后兼容:退化读旧变量/单地址
    pub = parsePanels(process.env.TRADING_PANELS);
  }
  if (!pub.length && process.env.SPYQ_STATION_URL) {
    pub = [{ label: '纸面实况', url: process.env.SPYQ_STATION_URL }];
  }
  res.json({ panels: pub });
});

// 属主追加面板(登录且为站长;控制台等)
router.get('/portal', authRequired, (req, res) => {
  if (!OWNER || req.user?.username !== OWNER) {
    return res.status(404).json({ error: 'Not Found' });
  }
  res.json({ panels: parsePanels(process.env.TRADING_PANELS_OWNER) });
});

module.exports = router;
