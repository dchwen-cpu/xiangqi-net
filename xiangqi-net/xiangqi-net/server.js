// 立山象棋室 · 多桌联机服务器（服务器权威回合 + playerId 认人 + 自动重同步）
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'lobby.html')));

const tables = new Map();
let seq = 1;
const newId = () => 't' + (seq++).toString(36) + Date.now().toString(36).slice(-3);
const turnOf = t => (t.moves.length % 2 === 0) ? 'r' : 'b';           // 权威回合：偶数手红先、奇数手黑

function summary(t){ return { id:t.id, name:t.name,
  red: t.seats.red?t.seats.red.name:null, black: t.seats.black?t.seats.black.name:null,
  spectators: t.spectators.size, status:t.status, moves:t.moves.length }; }
const lobbyList = () => [...tables.values()].map(summary);
const pushLobby = () => io.to('lobby').emit('lobby:list', lobbyList());
const playersMsg = t => ({ red:t.seats.red?t.seats.red.name:null, black:t.seats.black?t.seats.black.name:null, spectators:t.spectators.size, status:t.status });
function colorByPid(t, pid){ if(t.seats.red&&t.seats.red.pid===pid)return 'red'; if(t.seats.black&&t.seats.black.pid===pid)return 'black'; return null; }
function sendState(sock, t, seat){
  sock.emit('table:state', { tableId:t.id, name:t.name, seat,
    seats:{ red:t.seats.red?t.seats.red.name:null, black:t.seats.black?t.seats.black.name:null },
    moves:t.moves, turn:turnOf(t), status:t.status });
}
function resyncAll(t){                                    // 悔棋后让整桌所有人重同步到回退后的局面
  const room = io.sockets.adapter.rooms.get(t.id);
  if (!room) return;
  for (const sid of room){ const sk = io.sockets.sockets.get(sid); if (sk) sendState(sk, t, sk.data.seat); }
}

io.on('connection', (socket) => {
  socket.on('lobby:enter', () => { socket.data.tableId=null; socket.join('lobby'); socket.emit('lobby:list', lobbyList()); });

  socket.on('table:create', (p, ack) => {
    const id = newId();
    tables.set(id, { id, name:(p&&p.name)?String(p.name).slice(0,30):('棋桌 '+id.slice(-3)),
      seats:{red:null,black:null}, spectators:new Map(), moves:[], status:'waiting' });
    pushLobby(); if (typeof ack==='function') ack({ ok:true, id });
  });

  socket.on('table:join', (p, ack) => {
    const t = tables.get(p && p.tableId);
    if (!t){ if (typeof ack==='function') ack({ ok:false, err:'桌子不存在' }); return; }
    const pid = (p&&p.playerId)?String(p.playerId).slice(0,40):('anon'+socket.id);
    const name = (p&&p.name)?String(p.name).slice(0,20):('访客'+socket.id.slice(0,4));
    socket.leave('lobby');

    let seat = (p&&p.seat)||'auto';
    const existing = colorByPid(t, pid);                 // 同一 playerId 重连 → 归还原座
    if (existing) seat = existing;
    else {
      if (seat==='auto') seat = !t.seats.red?'red':(!t.seats.black?'black':'spectate');
      if (seat==='red' && t.seats.red) seat='spectate';
      if (seat==='black' && t.seats.black) seat='spectate';
    }
    if (seat==='red') t.seats.red = { pid, name, sid:socket.id };
    else if (seat==='black') t.seats.black = { pid, name, sid:socket.id };
    else { seat='spectate'; t.spectators.set(socket.id, { pid, name }); }

    socket.data.tableId=t.id; socket.data.seat=seat; socket.data.pid=pid; socket.data.name=name;
    socket.join(t.id);
    if (t.seats.red && t.seats.black && t.status==='waiting') t.status='playing';
    sendState(socket, t, seat);
    io.to(t.id).emit('table:players', playersMsg(t));
    pushLobby();
    if (typeof ack==='function') ack({ ok:true, seat });
  });

  socket.on('sync:request', () => { const t=tables.get(socket.data.tableId); if(t) sendState(socket,t,socket.data.seat); });

  socket.on('move', (m) => {
    const t = tables.get(socket.data.tableId); if (!t||!m) return;
    const color = colorByPid(t, socket.data.pid);
    if (!color){ sendState(socket,t,socket.data.seat); return; }            // 失位/观战 → 让它重同步
    if (color !== turnOf(t)){ sendState(socket,t,socket.data.seat); return; } // 非其回合 → 拒收并只让该客户端重同步
    const idx = t.moves.length;
    t.moves.push({ fr:m.fr, fc:m.fc, tr:m.tr, tc:m.tc });
    socket.to(t.id).emit('move', { fr:m.fr, fc:m.fc, tr:m.tr, tc:m.tc, by:color, idx });  // 只发给其他人，发送者本地已应用
  });

  socket.on('chat', (p) => { const t=tables.get(socket.data.tableId); const text=p&&String(p.text||'').slice(0,300);
    if (t&&text) io.to(t.id).emit('chat',{ name:socket.data.name, seat:socket.data.seat, text, ts:Date.now() }); });

  socket.on('resign', () => { const t=tables.get(socket.data.tableId); if(!t)return; const color=colorByPid(t,socket.data.pid); if(!color)return;
    t.status='over'; io.to(t.id).emit('table:over',{ reason:(color==='red'?'红方':'黑方')+'认输', winner:color==='red'?'black':'red' }); pushLobby(); });

  // 悔棋：一方请求 → 转给对方 → 对方同意则回退一手并全桌重同步
  socket.on('undo:request', () => { const t=tables.get(socket.data.tableId); if(!t)return; if(!colorByPid(t,socket.data.pid))return; socket.to(t.id).emit('undo:request'); });
  socket.on('undo:reject', () => { const t=tables.get(socket.data.tableId); if(t) socket.to(t.id).emit('undo:reject'); });
  socket.on('undo:accept', () => { const t=tables.get(socket.data.tableId); if(!t||!t.moves.length)return; t.moves.pop(); resyncAll(t); io.to(t.id).emit('chat',{name:'系统',seat:'',text:'双方同意，悔棋一手',ts:Date.now()}); pushLobby(); });

  // 求和：一方请求 → 转给对方 → 对方同意则判和
  socket.on('draw:request', () => { const t=tables.get(socket.data.tableId); if(!t)return; if(!colorByPid(t,socket.data.pid))return; socket.to(t.id).emit('draw:request'); });
  socket.on('draw:reject', () => { const t=tables.get(socket.data.tableId); if(t) socket.to(t.id).emit('draw:reject'); });
  socket.on('draw:accept', () => { const t=tables.get(socket.data.tableId); if(!t)return; t.status='over'; io.to(t.id).emit('table:over',{reason:'双方议和，和棋',winner:null}); pushLobby(); });

  socket.on('disconnect', () => {
    const t=tables.get(socket.data.tableId); if(!t){ pushLobby(); return; }
    if (t.seats.red && t.seats.red.sid===socket.id) t.seats.red=null;
    else if (t.seats.black && t.seats.black.sid===socket.id) t.seats.black=null;
    else t.spectators.delete(socket.id);
    io.to(t.id).emit('table:players', playersMsg(t));
    if (!t.seats.red && !t.seats.black && t.spectators.size===0) tables.delete(t.id);
    pushLobby();
  });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('立山象棋室 running on :' + PORT));
