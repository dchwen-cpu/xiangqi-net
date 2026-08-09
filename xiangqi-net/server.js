// 立山象棋室 · 服务器 v2
// 修复：断线8秒缓冲期（强制刷新不丢座）；用 SID 守座位杜绝竞争；悔棋/求和/认输。
const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'lobby.html')));

// ── 数据结构 ──────────────────────────────────────────────────
const tables = new Map();          // tableId → table
const recoTimers = new Map();      // socketId → {timer, tableId, pid}
let seq = 1;
const newId = () => 't' + (seq++).toString(36) + Date.now().toString(36).slice(-3);

// 权威回合：偶数步红先，奇数步黑走
const turnOf = t => (t.moves.length % 2 === 0) ? 'r' : 'b';

// ── 工具函数 ──────────────────────────────────────────────────
const summary = t => ({
  id: t.id, name: t.name,
  red:   t.seats.red   ? t.seats.red.name   : null,
  black: t.seats.black ? t.seats.black.name : null,
  spectators: t.spectators.size,
  status: t.status, moves: t.moves.length
});
const lobbyList  = () => [...tables.values()].map(summary);
const pushLobby  = () => io.to('lobby').emit('lobby:list', lobbyList());
const playersMsg = t => ({
  red:   t.seats.red   ? t.seats.red.name   : null,
  black: t.seats.black ? t.seats.black.name : null,
  spectators: t.spectators.size, status: t.status
});

// 用 SID 查座位（当前连接的唯一标识，避免旧 socket 干扰新连接的座位）
function colorBySid(t, sid) {
  if (t.seats.red   && t.seats.red.sid   === sid) return 'red';
  if (t.seats.black && t.seats.black.sid === sid) return 'black';
  return null;
}
// 用 PID 查座位（重连恢复座位）
function colorByPid(t, pid) {
  if (t.seats.red   && t.seats.red.pid   === pid) return 'red';
  if (t.seats.black && t.seats.black.pid === pid) return 'black';
  return null;
}
// 仅当 SID 匹配时才清座（防止新连接被旧 disconnect 清掉）
function clearSeat(t, sid) {
  if (t.seats.red   && t.seats.red.sid   === sid) { t.seats.red   = null; return 'red';   }
  if (t.seats.black && t.seats.black.sid === sid) { t.seats.black = null; return 'black'; }
  return null;
}
function sendState(sock, t, seat) {
  sock.emit('table:state', {
    tableId: t.id, name: t.name, seat,
    seats: { red: t.seats.red?.name||null, black: t.seats.black?.name||null },
    moves: t.moves, turn: turnOf(t), status: t.status
  });
}
function resyncAll(t) {
  const room = io.sockets.adapter.rooms.get(t.id);
  if (!room) return;
  for (const sid of room) {
    const sk = io.sockets.sockets.get(sid);
    if (sk) sendState(sk, t, sk.data.seat || 'spectate');
  }
}

// ── 主连接处理 ────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('lobby:enter', () => {
    socket.data.tableId = null;
    socket.join('lobby');
    socket.emit('lobby:list', lobbyList());
  });

  socket.on('table:create', (p, ack) => {
    const id = newId();
    tables.set(id, {
      id, name: (p?.name ? String(p.name).slice(0,30) : ('棋桌 ' + id.slice(-3))),
      seats: { red: null, black: null }, spectators: new Set(),
      moves: [], status: 'waiting'
    });
    pushLobby();
    if (typeof ack === 'function') ack({ ok: true, id });
  });

  socket.on('table:join', (p, ack) => {
    const t = tables.get(p?.tableId);
    if (!t) { if (typeof ack==='function') ack({ ok:false, err:'桌子不存在' }); return; }

    const pid  = (p?.playerId ? String(p.playerId).slice(0,40) : ('anon'+socket.id));
    const name = (p?.name     ? String(p.name).slice(0,20)     : ('访客'+socket.id.slice(0,4)));
    socket.leave('lobby');

    // 取消该 PID 的断线缓冲计时器（强制刷新重连场景）
    for (const [sid, d] of recoTimers.entries()) {
      if (d.pid === pid && d.tableId === p.tableId) {
        clearTimeout(d.timer);
        recoTimers.delete(sid);
        break;
      }
    }

    // 座位分配：同 PID 重连优先恢复原座；否则按请求或自动分配
    let seat = p?.seat || 'auto';
    const existing = colorByPid(t, pid);
    if (existing) {
      seat = existing;   // 重连恢复原座
    } else {
      if (seat === 'auto')   seat = !t.seats.red ? 'red' : (!t.seats.black ? 'black' : 'spectate');
      if (seat === 'red'   && t.seats.red)   seat = 'spectate';
      if (seat === 'black' && t.seats.black) seat = 'spectate';
    }

    if      (seat === 'red')   t.seats.red   = { pid, name, sid: socket.id };
    else if (seat === 'black') t.seats.black = { pid, name, sid: socket.id };
    else { seat = 'spectate'; t.spectators.add(socket.id); }

    socket.data.tableId = t.id;
    socket.data.seat    = seat;
    socket.data.pid     = pid;
    socket.data.name    = name;
    socket.join(t.id);

    if (t.seats.red && t.seats.black && t.status === 'waiting') t.status = 'playing';

    sendState(socket, t, seat);                     // 发给本人
    io.to(t.id).emit('table:players', playersMsg(t)); // 发给桌内所有人
    pushLobby();
    if (typeof ack === 'function') ack({ ok: true, seat });
  });

  socket.on('sync:request', () => {
    const t = tables.get(socket.data.tableId);
    if (t) sendState(socket, t, socket.data.seat || 'spectate');
  });

  socket.on('move', m => {
    const t = tables.get(socket.data.tableId);
    if (!t || !m) return;
    const color = colorBySid(t, socket.id);               // 用 SID 确认座位
    if (!color) { sendState(socket, t, socket.data.seat||'spectate'); return; }
    const need = turnOf(t) === 'r' ? 'red' : 'black';
    if (color !== need) { sendState(socket, t, socket.data.seat||'spectate'); return; } // 非本方回合
    const idx = t.moves.length;
    t.moves.push({ fr: m.fr, fc: m.fc, tr: m.tr, tc: m.tc });
    // 只发给其他人，发送者本地已应用
    socket.to(t.id).emit('move', { fr: m.fr, fc: m.fc, tr: m.tr, tc: m.tc, by: color, idx });
  });

  socket.on('chat', p => {
    const t = tables.get(socket.data.tableId);
    const text = p && String(p.text||'').slice(0,300);
    if (t && text) io.to(t.id).emit('chat', { name: socket.data.name||'访客', seat: socket.data.seat, text, ts: Date.now() });
  });

  socket.on('resign', () => {
    const t = tables.get(socket.data.tableId);
    if (!t) return;
    const color = colorBySid(t, socket.id);
    if (!color) return;
    t.status = 'over';
    io.to(t.id).emit('table:over', { reason: (color==='red'?'红方':'黑方')+'认输', winner: color==='red'?'black':'red' });
    pushLobby();
  });

  // 悔棋/求和 协商
  socket.on('undo:request', () => { const t=tables.get(socket.data.tableId); if(!t||!colorBySid(t,socket.id))return; socket.to(t.id).emit('undo:request'); });
  socket.on('undo:reject',  () => { const t=tables.get(socket.data.tableId); if(t) socket.to(t.id).emit('undo:reject'); });
  socket.on('undo:accept',  () => {
    const t=tables.get(socket.data.tableId);
    if(!t||!t.moves.length)return;
    t.moves.pop();
    resyncAll(t);
    io.to(t.id).emit('chat',{name:'系统',seat:'',text:'双方同意，悔棋一手',ts:Date.now()});
    pushLobby();
  });
  socket.on('draw:request', () => { const t=tables.get(socket.data.tableId); if(!t||!colorBySid(t,socket.id))return; socket.to(t.id).emit('draw:request'); });
  socket.on('draw:reject',  () => { const t=tables.get(socket.data.tableId); if(t) socket.to(t.id).emit('draw:reject'); });
  socket.on('draw:accept',  () => {
    const t=tables.get(socket.data.tableId);
    if(!t)return;
    t.status='over';
    io.to(t.id).emit('table:over',{reason:'双方议和，和棋',winner:null});
    pushLobby();
  });

  socket.on('disconnect', () => {
    const t = tables.get(socket.data.tableId);
    if (!t) { pushLobby(); return; }

    const color = colorBySid(t, socket.id);
    t.spectators.delete(socket.id);

    if (color) {
      // 8 秒缓冲期：强制刷新通常在 1-2 秒内重连，不清座位；
      // 真正离线的玩家 8 秒后座位才释放。
      const sid = socket.id;
      const timer = setTimeout(() => {
        recoTimers.delete(sid);
        const cleared = clearSeat(t, sid);
        if (cleared) {
          if (t.status === 'playing') t.status = 'waiting';
          io.to(t.id).emit('table:players', playersMsg(t));
          if (!t.seats.red && !t.seats.black && t.spectators.size === 0) tables.delete(t.id);
          pushLobby();
        }
      }, 8000);
      recoTimers.set(sid, { timer, tableId: t.id, pid: socket.data.pid });
      // 断线期间仍广播（玩家名保留，但连接中断——前端可用此判断是否在线）
    }

    io.to(t.id).emit('table:players', playersMsg(t));
    pushLobby();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('立山象棋室 v2 running on :' + PORT));
