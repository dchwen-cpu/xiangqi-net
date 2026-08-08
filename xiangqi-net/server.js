// 立山象棋室 · 多桌联机服务器（Node + Express + Socket.IO）
// 职责：管理多张棋桌、红/黑座位与观战者、转发着法与聊天、为新加入者同步历史着法。
// 规则裁决仍由每个客户端里的“立山象棋”完成，服务器只做座位/回合的基本把关。
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// 静态托管：public/ 里放 lobby.html（大厅）和 xiangqi/（你的象棋 app + netplay.js）
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'lobby.html')));

const tables = new Map();          // id -> 桌
let seq = 1;
const newId = () => 't' + (seq++).toString(36) + Date.now().toString(36).slice(-3);

function summary(t){
  return { id:t.id, name:t.name,
    red: t.seats.red ? t.seats.red.name : null,
    black: t.seats.black ? t.seats.black.name : null,
    spectators: t.spectators.size, status:t.status, moves:t.moves.length };
}
const lobbyList = () => [...tables.values()].map(summary);
const pushLobby = () => io.to('lobby').emit('lobby:list', lobbyList());

function colorOf(t, id){
  if (t.seats.red && t.seats.red.id === id) return 'red';
  if (t.seats.black && t.seats.black.id === id) return 'black';
  return null;
}
function playersMsg(t){
  return { red: t.seats.red?t.seats.red.name:null, black: t.seats.black?t.seats.black.name:null,
           spectators: t.spectators.size, status:t.status };
}

io.on('connection', (socket) => {
  let name = '访客' + socket.id.slice(0,4);

  socket.on('lobby:enter', (p) => {
    if (p && p.name) name = String(p.name).slice(0,20);
    socket.join('lobby');
    socket.emit('lobby:list', lobbyList());
  });

  socket.on('table:create', (p, ack) => {
    const id = newId();
    tables.set(id, { id, name: (p&&p.name)?String(p.name).slice(0,30):('棋桌 '+id.slice(-3)),
      seats:{red:null,black:null}, spectators:new Set(), moves:[], turn:'r', status:'waiting' });
    pushLobby();
    if (typeof ack === 'function') ack({ ok:true, id });
  });

  socket.on('table:join', (p, ack) => {
    const t = tables.get(p && p.tableId);
    if (!t){ if (typeof ack==='function') ack({ ok:false, err:'桌子不存在' }); return; }
    if (p && p.name) name = String(p.name).slice(0,20);
    socket.leave('lobby');

    let seat = (p && p.seat) || 'auto';
    if (seat === 'auto') seat = !t.seats.red ? 'red' : (!t.seats.black ? 'black' : 'spectate');
    if (seat === 'red' && t.seats.red) seat = 'spectate';
    if (seat === 'black' && t.seats.black) seat = 'spectate';

    if (seat === 'red') t.seats.red = { id:socket.id, name };
    else if (seat === 'black') t.seats.black = { id:socket.id, name };
    else { seat = 'spectate'; t.spectators.add(socket.id); }

    socket.data.tableId = t.id; socket.data.seat = seat; socket.data.name = name;
    socket.join(t.id);
    if (t.seats.red && t.seats.black && t.status === 'waiting') t.status = 'playing';

    socket.emit('table:state', { tableId:t.id, name:t.name, seat,
      seats:{ red:t.seats.red?t.seats.red.name:null, black:t.seats.black?t.seats.black.name:null },
      moves:t.moves, turn:t.turn, status:t.status });
    io.to(t.id).emit('table:players', playersMsg(t));
    pushLobby();
    if (typeof ack === 'function') ack({ ok:true, seat });
  });

  socket.on('move', (m) => {
    const t = tables.get(socket.data.tableId);
    if (!t || !m) return;
    const color = colorOf(t, socket.id);
    if (!color) return;                                  // 观战者不能走
    const need = t.turn === 'r' ? 'red' : 'black';
    if (color !== need) return;                          // 不是你的回合
    t.moves.push({ fr:m.fr, fc:m.fc, tr:m.tr, tc:m.tc });
    t.turn = t.turn === 'r' ? 'b' : 'r';
    socket.to(t.id).emit('move', { fr:m.fr, fc:m.fc, tr:m.tr, tc:m.tc, by:color });  // 除自己外广播
  });

  socket.on('chat', (p) => {
    const t = tables.get(socket.data.tableId);
    const text = p && String(p.text||'').slice(0,300);
    if (!t || !text) return;
    io.to(t.id).emit('chat', { name: socket.data.name||name, seat: socket.data.seat, text, ts: Date.now() });
  });

  socket.on('resign', () => {
    const t = tables.get(socket.data.tableId);
    if (!t) return;
    const color = colorOf(t, socket.id);
    if (!color) return;
    t.status = 'over';
    io.to(t.id).emit('table:over', { reason:(color==='red'?'红方':'黑方')+'认输', winner: color==='red'?'black':'red' });
    pushLobby();
  });

  socket.on('disconnect', () => {
    const t = tables.get(socket.data.tableId);
    if (!t){ pushLobby(); return; }
    const color = colorOf(t, socket.id);
    if (color === 'red') t.seats.red = null;
    else if (color === 'black') t.seats.black = null;
    else t.spectators.delete(socket.id);
    io.to(t.id).emit('table:players', playersMsg(t));
    if (!t.seats.red && !t.seats.black && t.spectators.size === 0) tables.delete(t.id);  // 空桌回收
    pushLobby();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('立山象棋室 running on :' + PORT));
