// db.js —— 立山斋棋牌室 数据层（SQLite / better-sqlite3）
//
// ⚠️ 库文件必须落在 Render 持久盘的挂载路径下，否则每次部署都会被清空！
//    用环境变量 DB_PATH 指定，例如 /data/lishanzhai.db（见部署说明）。
//    本地开发不设 DB_PATH 时，默认写到 ./data/lishanzhai.db。

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');
const rating = require('./rating');   // Glicko-2 算分

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'lishanzhai.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });   // 确保目录存在

const db = new Database(DB_PATH);
console.log('[db] SQLite 数据库路径:', DB_PATH, '（这个路径必须在持久盘的挂载路径下，否则重新部署会清空）');
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

CREATE TABLE IF NOT EXISTS visits (
  visitor_id TEXT NOT NULL,
  day        TEXT NOT NULL,        -- 服务器日期 YYYY-MM-DD
  PRIMARY KEY (visitor_id, day)    -- 同一访客同一天只记一次
);

CREATE TABLE IF NOT EXISTS articles (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id      INTEGER NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  excerpt        TEXT,
  comments_open  INTEGER NOT NULL DEFAULT 1,   -- 1=开放留言 0=关闭
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY(author_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  nickname   TEXT NOT NULL,              -- 访客填的昵称，或注册用户的用户名
  user_id    INTEGER,                    -- 注册用户留言时记录 id，访客为 NULL
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(article_id) REFERENCES articles(id),
  FOREIGN KEY(user_id)    REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS collections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',    -- 简短备注
  tag        TEXT NOT NULL DEFAULT '其它', -- 分类标签
  created_at INTEGER NOT NULL
);
`);

// 给已有的 articles 表补加 comments_open 列（幂等：列已存在时忽略错误）
try { db.exec(`ALTER TABLE articles ADD COLUMN comments_open INTEGER NOT NULL DEFAULT 1`); }
catch(e) { /* 列已存在，忽略 */ }

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

// ── 访问计数 ──
const visitStmts = {
  insert: db.prepare(`INSERT OR IGNORE INTO visits (visitor_id, day) VALUES (?, ?)`),
  total:  db.prepare(`SELECT COUNT(*) AS n FROM visits`),
  uniq:   db.prepare(`SELECT COUNT(DISTINCT visitor_id) AS n FROM visits`),
};
// 记一次访问（同访客同天自动去重），返回累计数据
function recordVisit(visitorId){
  const day = new Date().toISOString().slice(0, 10);   // 服务器日期，防客户端改钟
  visitStmts.insert.run(visitorId, day);
  return { total: visitStmts.total.get().n, unique: visitStmts.uniq.get().n };
}

// ── 文章（文墨）── 懒加载 prepare，避免启动时列还没加好就崩
let _artStmts = null;
function artStmts(){
  if(!_artStmts) _artStmts = {
    insert: db.prepare(`INSERT INTO articles (author_id,title,body,excerpt,comments_open,created_at,updated_at)
                        VALUES (?,?,?,?,?,?,?)`),
    update: db.prepare(`UPDATE articles SET title=?, body=?, excerpt=?, comments_open=?, updated_at=? WHERE id=?`),
    del:    db.prepare(`DELETE FROM articles WHERE id=?`),
    byId:   db.prepare(`SELECT a.*, u.username AS author FROM articles a
                        JOIN users u ON u.id=a.author_id WHERE a.id=?`),
    list:   db.prepare(`SELECT id,title,excerpt,created_at FROM articles ORDER BY created_at DESC`),
  };
  return _artStmts;
}
function createArticle(authorId, title, body, excerpt, commentsOpen){
  const now = Date.now();
  const info = artStmts().insert.run(authorId, title, body, excerpt, commentsOpen?1:0, now, now);
  return artStmts().byId.get(info.lastInsertRowid);
}
function updateArticle(id, title, body, excerpt, commentsOpen){
  const r = artStmts().update.run(title, body, excerpt, commentsOpen?1:0, Date.now(), id);
  return r.changes ? artStmts().byId.get(id) : null;
}
function deleteArticle(id){ return artStmts().del.run(id).changes > 0; }
function getArticle(id){ return artStmts().byId.get(id); }
function listArticles(){ return artStmts().list.all(); }

// ── 留言 ──
const cmtStmts = {
  insert: db.prepare(`INSERT INTO comments (article_id,nickname,user_id,body,created_at)
                      VALUES (?,?,?,?,?)`),
  list:   db.prepare(`SELECT id,nickname,user_id,body,created_at FROM comments
                      WHERE article_id=? ORDER BY created_at ASC`),
  del:    db.prepare(`DELETE FROM comments WHERE id=?`),
  byId:   db.prepare(`SELECT * FROM comments WHERE id=?`),
};
function addComment(articleId, nickname, userId, body){
  const info = cmtStmts.insert.run(articleId, nickname, userId||null, body, Date.now());
  return cmtStmts.byId.get(info.lastInsertRowid);
}
function listComments(articleId){ return cmtStmts.list.all(articleId); }
function deleteComment(id){ return cmtStmts.del.run(id).changes > 0; }

// ── 收藏 ──
const colStmts = {
  insert: db.prepare(`INSERT INTO collections (url,title,note,tag,created_at) VALUES (?,?,?,?,?)`),
  list:   db.prepare(`SELECT * FROM collections ORDER BY tag ASC, created_at DESC`),
  del:    db.prepare(`DELETE FROM collections WHERE id=?`),
  byId:   db.prepare(`SELECT * FROM collections WHERE id=?`),
  tags:   db.prepare(`SELECT DISTINCT tag FROM collections ORDER BY tag ASC`),
};
function addCollection(url, title, note, tag){
  const info = colStmts.insert.run(url, title, note||'', tag||'其它', Date.now());
  return colStmts.byId.get(info.lastInsertRowid);
}
function listCollections(){ return colStmts.list.all(); }
function deleteCollection(id){ return colStmts.del.run(id).changes > 0; }
function listTags(){ return colStmts.tags.all().map(r=>r.tag); }

// ── 对局算分（Glicko-2 棋力 + 积分）──
let _rateStmts = null;
function rateStmts(){
  if(!_rateStmts) _rateStmts = {
    upd: db.prepare(`UPDATE users SET rating=?, rd=?, vol=?, games=games+1,
                       wins=wins+?, losses=losses+?, draws=draws+?, points=MAX(0,points+?)
                     WHERE id=?`),
    rec: db.prepare(`INSERT INTO game_results (ts,red_id,black_id,winner,table_id) VALUES (?,?,?,?,?)`),
  };
  return _rateStmts;
}
// winner: 'red' | 'black' | 'draw'  —— 返回双方更新后的公开资料
function applyGameResult(redId, blackId, winner, tableId){
  const red = stmts.byId.get(redId), black = stmts.byId.get(blackId);
  if(!red || !black) return null;
  const redScore   = winner==='red' ? 1 : (winner==='draw' ? 0.5 : 0);
  const blackScore = 1 - redScore;

  const nr = rating.updatePlayer({rating:red.rating, rd:red.rd, vol:red.vol},
                                 [{rating:black.rating, rd:black.rd, score:redScore}]);
  const nb = rating.updatePlayer({rating:black.rating, rd:black.rd, vol:black.vol},
                                 [{rating:red.rating, rd:red.rd, score:blackScore}]);

  const pts = s => (s===1 ? 16 : (s===0.5 ? 0 : -16));   // 积分：胜+16 和0 负-16
  const wld = s => ({ w: s===1?1:0, l: s===0?1:0, d: s===0.5?1:0 });
  const rw = wld(redScore), bw = wld(blackScore);

  const tx = db.transaction(() => {
    rateStmts().upd.run(nr.rating, nr.rd, nr.vol, rw.w, rw.l, rw.d, pts(redScore),   redId);
    rateStmts().upd.run(nb.rating, nb.rd, nb.vol, bw.w, bw.l, bw.d, pts(blackScore), blackId);
    rateStmts().rec.run(Date.now(), redId, blackId, winner, tableId||null);
  });
  tx();
  return { red: publicProfile(stmts.byId.get(redId)), black: publicProfile(stmts.byId.get(blackId)) };
}

// ── 排行榜 ──
// 定级完成（games>=PLACEMENT_GAMES）的用户，按棋力降序
const lbStmt = db.prepare(`SELECT username, ROUND(rating) AS rating, games, wins, losses, draws, points
                           FROM users WHERE games >= ? ORDER BY rating DESC LIMIT ?`);
function leaderboard(limit){ return lbStmt.all(PLACEMENT_GAMES, limit||100); }

module.exports = {
  db, createUser, findByName, findById, publicProfile, recordVisit, PLACEMENT_GAMES,
  createArticle, updateArticle, deleteArticle, getArticle, listArticles,
  addComment, listComments, deleteComment,
  addCollection, listCollections, deleteCollection, listTags,
  applyGameResult, leaderboard,
};
