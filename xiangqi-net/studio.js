// studio.js —— 立山斋个人站的后端接口，挂在 /api/studio 下
//   文章：列表 / 单篇（公开可读）；发表 / 修改 / 删除（仅站长）
//   站长由环境变量 OWNER_USERNAME 指定（填你注册的那个用户名）。

const express = require('express');
const dbx = require('./db');
const { authRequired } = require('./auth');

const router = express.Router();
const OWNER = process.env.OWNER_USERNAME || '';
if (!OWNER) console.warn('[studio] 未设 OWNER_USERNAME —— 发表/修改文章会被拒绝，请在 Render 环境变量里填你的用户名。');

// 站长校验：必须已登录，且登录的就是站长本人
function ownerOnly(req, res, next){
  if (!OWNER) return res.status(500).json({ error: '服务器未配置站长账号（OWNER_USERNAME）' });
  if (req.user?.username !== OWNER) return res.status(403).json({ error: '仅站长可发表文章' });
  next();
}

// 列表（公开）
router.get('/articles', (_req, res) => res.json(dbx.listArticles()));

// 单篇（公开）
router.get('/articles/:id', (req, res) => {
  const a = dbx.getArticle(Number(req.params.id));
  if (!a) return res.status(404).json({ error: '文章不存在' });
  res.json(a);
});

// 是否站长（前端用来决定要不要显示编辑入口）
router.get('/whoami', authRequired, (req, res) => {
  res.json({ username: req.user.username, isOwner: req.user.username === OWNER });
});

// 发表（站长）
router.post('/articles', authRequired, ownerOnly, (req, res) => {
  const title   = String(req.body?.title || '').trim();
  const body    = String(req.body?.body || '');
  const excerpt = String(req.body?.excerpt || '').slice(0, 200);
  if (!title)        return res.status(400).json({ error: '标题不能为空' });
  if (body.length < 1) return res.status(400).json({ error: '正文不能为空' });
  const user = dbx.findByName(req.user.username);
  res.json(dbx.createArticle(user.id, title, body, excerpt));
});

// 修改（站长）
router.put('/articles/:id', authRequired, ownerOnly, (req, res) => {
  const title   = String(req.body?.title || '').trim();
  const body    = String(req.body?.body || '');
  const excerpt = String(req.body?.excerpt || '').slice(0, 200);
  if (!title) return res.status(400).json({ error: '标题不能为空' });
  const a = dbx.updateArticle(Number(req.params.id), title, body, excerpt);
  if (!a) return res.status(404).json({ error: '文章不存在' });
  res.json(a);
});

// 删除（站长）
router.delete('/articles/:id', authRequired, ownerOnly, (req, res) => {
  dbx.deleteArticle(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
