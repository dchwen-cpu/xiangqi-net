// trading.js —— 立山斋 → SPYQ 交易世界的属主门厅(仅站长可见)
//   挂载: app.use('/api/trading', require('./trading'));
//   隐身原则: 非站长一律 404(不暴露"此处有东西"),不是 403。
//   面板地址只存服务端环境变量,永不写进前端代码:
//     TRADING_PANELS  JSON 数组, 如:
//       [{"label":"纸面实况","url":"https://spyq-station.onrender.com/"},
//        {"label":"日记","url":"https://spyq-station.onrender.com/diary"}]
//     (未设时退化读 SPYQ_STATION_URL 单面板)
//   将来对外展馆(战绩公开/配方遮蔽)另开公开路由,不动此门厅。

const express = require('express');
const { authRequired } = require('./auth');

const router = express.Router();
const OWNER = process.env.OWNER_USERNAME || '';

function panels() {
  const raw = process.env.TRADING_PANELS || '';
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) {
      console.warn('[trading] TRADING_PANELS 不是合法 JSON,已忽略');
    }
  }
  const st = process.env.SPYQ_STATION_URL || '';
  return st ? [{ label: '纸面实况', url: st }] : [];
}

// 属主门厅配置(站长专属;非站长 404 隐身)
router.get('/portal', authRequired, (req, res) => {
  if (!OWNER || req.user?.username !== OWNER) {
    return res.status(404).json({ error: 'Not Found' });
  }
  res.json({ panels: panels() });
});

module.exports = router;
