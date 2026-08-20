// auth.js —— 注册 / 登录 / 当前用户，挂在 /auth 下
// 依赖：bcryptjs（哈希密码）、jsonwebtoken（签发登录令牌）、./db
//
// ⚠️ 需要环境变量 JWT_SECRET（一段长随机串）。见部署说明里怎么生成。

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const dbx     = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[auth] 缺少 JWT_SECRET 环境变量——注册/登录会返回 500。请在 Render 环境变量里设置。');
}

function sign(user){
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

// POST /auth/register  { username, password } → { token, username, points, rating, ... }
router.post('/register', (req, res) => {
  try {
    if (!JWT_SECRET) return res.status(500).json({ error: '服务器未配置认证密钥' });
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名需 2–20 个字符' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (dbx.findByName(username)) return res.status(409).json({ error: '该用户名已被占用' });

    const user  = dbx.createUser(username, bcrypt.hashSync(password, 10));
    const token = sign(user);
    res.json({ token, ...dbx.publicProfile(user) });
  } catch (e) {
    console.error('[auth] register error', e);
    res.status(500).json({ error: '注册失败，请稍后再试' });
  }
});

// POST /auth/login  { username, password } → { token, username, points, rating, ... }
router.post('/login', (req, res) => {
  try {
    if (!JWT_SECRET) return res.status(500).json({ error: '服务器未配置认证密钥' });
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const user = dbx.findByName(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    res.json({ token: sign(user), ...dbx.publicProfile(user) });
  } catch (e) {
    console.error('[auth] login error', e);
    res.status(500).json({ error: '登录失败，请稍后再试' });
  }
});

// 中间件：要求请求头带有效 token（供以后发帖、记分等用）
function authRequired(req, res, next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: '请先登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);   // { id, username }
    next();
  } catch (e) {
    res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// GET /auth/me → 最新 profile（用于刷新积分/棋力显示）
router.get('/me', authRequired, (req, res) => {
  const user = dbx.findById(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(dbx.publicProfile(user));
});

module.exports = { router, authRequired };
