// db.js —— 立山斋棋牌室 数据层（SQLite / better-sqlite3）
//
// ⚠️ 库文件必须落在 Render 持久盘的挂载路径下，否则每次部署都会被清空！
//    用环境变量 DB_PATH 指定，例如 /data/lishanzhai.db（见部署说明）。
//    本地开发不设 DB_PATH 时，默认写到 ./data/lishanzhai.db。

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'lishanzhai.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });   // 确保目录存在

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');    // 并发读写更稳
db.pragma('foreign_keys = ON');

// ── 建表（幂等：服务每次启动都跑，已存在就跳过）───────────────
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  points        INTEGER NOT NULL DEFAULT 1000,   -- 积分（简单货币）
  rating        REAL    NOT NULL DEFAULT 1500,   -- Glicko-2 实战分
  rd            REAL    NOT NULL DEFAULT 350,     -- 评分偏差
  vol           REAL    NOT NULL DEFAULT 0.06,    -- 波动率
  ai_rating     REAL,                            -- 人机客观分（本步先留空）
  games         INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  draws         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_results (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  red_id   INTEGER,
  black_id INTEGER,
  winner   TEXT,                       -- 'red' | 'black' | 'draw'
  table_id TEXT,
  FOREIGN KEY(red_id)   REFERENCES users(id),
  FOREIGN KEY(black_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS forum_posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id     INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  reply_count   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(author_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS forum_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  author_id  INTEGER NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(post_id)   REFERENCES forum_posts(id),
  FOREIGN KEY(author_id) REFERENCES users(id)
);
`);

// ── 定级门槛：对局数不足则棋力显示"未定级" ──
const PLACEMENT_GAMES = 5;

// ── 预编译语句（用户相关，本步用到）──
const stmts = {
  insertUser: db.prepare(`INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)`),
  byName:     db.prepare(`SELECT * FROM users WHERE username = ?`),
  byId:       db.prepare(`SELECT * FROM users WHERE id = ?`),
};

function createUser(username, passwordHash){
  const info = stmts.insertUser.run(username, passwordHash, Date.now());
  return stmts.byId.get(info.lastInsertRowid);
}
function findByName(username){ return stmts.byName.get(username); }
function findById(id){ return stmts.byId.get(id); }

// 对外暴露给客户端的安全字段——绝不含 password_hash / rd / vol
function publicProfile(u){
  if(!u) return null;
  return {
    username: u.username,
    points:   u.points,
    // 定级局不足时返回 null，门厅会显示"未定级"
    rating:   u.games >= PLACEMENT_GAMES ? Math.round(u.rating) : null,
    games:    u.games, wins: u.wins, losses: u.losses, draws: u.draws,
  };
}

module.exports = { db, createUser, findByName, findById, publicProfile, PLACEMENT_GAMES };
