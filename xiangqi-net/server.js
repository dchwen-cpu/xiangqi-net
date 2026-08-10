// 立山象棋室 · 服务器 v3  — 候棋室 + 游戏选项 + 双方准备后开局
const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:'*' } });
app.use(express.static(path.join(__dirname,'public')));
app.get('/', (_,res) => res.sendFile(path.join(__dirname,'public','lobby.html')));

const tables     = new Map();
const recoTimers = new Map();
let seq = 1;
const newId = () => 't'+(seq++).toString(36)+Date.now().toString(36).slice(-3);
const turnOf = t => t.moves.length%2===0 ? 'r' : 'b';

// ── 工具 ──────────────────────────────────────────────────────
const mkOptions = () => ({ type:'free', perMove:0, total:0, handicap:'' });
const mkReady   = () => ({ red:false, black:false });

const summary = t => ({
  id:t.id, name:t.name,
  red:   t.seats.red   ? t.seats.red.name   : null,
  black: t.seats.black ? t.seats.black.name : null,
  spectators: t.spectators.size,
  status:t.status, moves:t.moves.length,
  ready:{...t.ready}, options:{...t.options}     // 大厅桌卡内联显示设置与就绪状态
});
const lobbyList  = ()  => [...tables.values()].map(summary);
const pushLobby  = ()  => io.to('lobby').emit('lobby:list', lobbyList());
const playersMsg = (t,extra) => ({
  red:   t.seats.red   ? t.seats.red.name   : null,
  black: t.seats.black ? t.seats.black.name : null,
  spectators: t.spectators.size, status:t.status,
  ready: { ...t.ready }, ...extra
});

function colorBySid(t,sid){
  if(t.seats.red   && t.seats.red.sid   ===sid) return 'red';
  if(t.seats.black && t.seats.black.sid ===sid) return 'black';
  return null;
}
function colorByPid(t,pid){
  if(t.seats.red   && t.seats.red.pid   ===pid) return 'red';
  if(t.seats.black && t.seats.black.pid ===pid) return 'black';
  return null;
}
function clearSeat(t,sid){
  if(t.seats.red   && t.seats.red.sid   ===sid){ t.seats.red   =null; return 'red';   }
  if(t.seats.black && t.seats.black.sid ===sid){ t.seats.black =null; return 'black'; }
  return null;
}
function sendState(sock,t,seat){
  sock.emit('table:state',{
    tableId:t.id, name:t.name, seat,
    seats:{ red:t.seats.red?.name||null, black:t.seats.black?.name||null },
    moves:t.moves, turn:turnOf(t), status:t.status,
    options:{ ...t.options }, ready:{ ...t.ready }
  });
}
function resyncAll(t){
  const room=io.sockets.adapter.rooms.get(t.id);
  if(!room)return;
  for(const sid of room){ const sk=io.sockets.sockets.get(sid); if(sk) sendState(sk,t,sk.data.seat||'spectate'); }
}
function broadcastRoom(t){ io.to(t.id).emit('table:players', playersMsg(t)); }
function pushOnline(){
  const room=io.sockets.adapter.rooms.get('lobby');
  io.to('lobby').emit('lobby:online', room?room.size:0);
}

// ── 连接处理 ──────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('lobby:enter', (p)=>{
    socket.data.tableId=null;
    if(p&&p.name) socket.data.name=String(p.name).slice(0,20);
    if(p&&p.playerId) socket.data.pid=String(p.playerId).slice(0,40);
    socket.join('lobby');
    socket.emit('lobby:list', lobbyList());
    pushOnline();
  });

  // 大厅公共聊天
  socket.on('lobby:chat', (p)=>{
    const text=p&&String(p.text||'').slice(0,200);
    if(!text) return;
    const name=(p&&p.name)?String(p.name).slice(0,20):(socket.data.name||'访客');
    io.to('lobby').emit('lobby:chat',{name,text,ts:Date.now()});
  });

  // 主动离桌（回大厅）
  socket.on('table:leave', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t) return;
    const color=colorBySid(t,socket.id);
    if(color){ t.seats[color]=null; t.ready[color]=false; }
    t.spectators.delete(socket.id);
    socket.leave(t.id);
    socket.data.tableId=null; socket.data.seat=null;
    socket.join('lobby');
    if(t.status==='playing') t.status='waiting';
    broadcastRoom(t);
    if(!t.seats.red&&!t.seats.black&&t.spectators.size===0) tables.delete(t.id);
    pushLobby();
  });

  socket.on('table:create', (p,ack)=>{
    const id=newId();
    tables.set(id,{
      id, name:(p?.name ? String(p.name).slice(0,30):('棋桌 '+id.slice(-3))),
      seats:{red:null,black:null}, spectators:new Set(),
      moves:[], status:'waiting',
      ready:mkReady(), options:mkOptions()
    });
    pushLobby();
    if(typeof ack==='function') ack({ok:true,id});
  });

  socket.on('table:join', (p,ack)=>{
    const t=tables.get(p?.tableId);
    if(!t){ if(typeof ack==='function') ack({ok:false,err:'桌子不存在'}); return; }

    const pid  = (p?.playerId?String(p.playerId).slice(0,40):('anon'+socket.id));
    const name = (p?.name    ?String(p.name).slice(0,20)    :('访客'+socket.id.slice(0,4)));
    socket.leave('lobby');

    // 取消断线计时器（强制刷新重连）
    for(const [sid,d] of recoTimers.entries()){
      if(d.pid===pid && d.tableId===p.tableId){ clearTimeout(d.timer); recoTimers.delete(sid); break; }
    }

    let seat=(p?.seat)||'auto';
    const existing=colorByPid(t,pid);
    if(existing){ seat=existing; }
    else{
      if(seat==='auto')    seat=!t.seats.red?'red':(!t.seats.black?'black':'spectate');
      if(seat==='red'   && t.seats.red)   seat='spectate';
      if(seat==='black' && t.seats.black) seat='spectate';
    }
    if     (seat==='red')   t.seats.red   ={pid,name,sid:socket.id};
    else if(seat==='black') t.seats.black ={pid,name,sid:socket.id};
    else                   { seat='spectate'; t.spectators.add(socket.id); }

    socket.data.tableId=t.id; socket.data.seat=seat; socket.data.pid=pid; socket.data.name=name;
    socket.join(t.id);

    sendState(socket,t,seat);
    broadcastRoom(t);
    pushLobby();
    if(typeof ack==='function') ack({ok:true,seat});
  });

  // 设置对局选项（任一玩家皆可，自动广播给候棋室另一方）
  socket.on('table:options', (opts,ack)=>{
    const t=tables.get(socket.data.tableId);
    if(!t||!colorBySid(t,socket.id)) return;
    t.options={
      type:    (opts?.type==='timed')?'timed':'free',
      perMove: Math.max(0, parseInt(opts?.perMove)||0),
      total:   Math.max(0, parseInt(opts?.total)  ||0),
      handicap:String(opts?.handicap||'').slice(0,20)
    };
    t.ready=mkReady();  // 选项变动后双方重新准备
    io.to(t.id).emit('table:options', { options:{...t.options}, ready:{...t.ready} });
    pushLobby();
    if(typeof ack==='function') ack({ok:true});
  });

  // 准备好了（双方都准备后发 game:start）
  socket.on('table:ready', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t) return;
    const seat=socket.data.seat;
    if(seat!=='red'&&seat!=='black') return;
    t.ready[seat]=true;
    broadcastRoom(t); pushLobby();
    if(t.ready.red && t.ready.black && t.seats.red && t.seats.black){
      t.status='playing';
      io.to(t.id).emit('game:start', { options:{...t.options} });
      pushLobby();
    }
  });

  socket.on('table:unready', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t) return;
    const seat=socket.data.seat;
    if(seat!=='red'&&seat!=='black') return;
    t.ready[seat]=false;
    broadcastRoom(t); pushLobby();
  });

  socket.on('sync:request', ()=>{ const t=tables.get(socket.data.tableId); if(t) sendState(socket,t,socket.data.seat||'spectate'); });

  socket.on('move', m=>{
    const t=tables.get(socket.data.tableId);
    if(!t||!m) return;
    const color=colorBySid(t,socket.id);
    if(!color){ sendState(socket,t,socket.data.seat||'spectate'); return; }
    const need=turnOf(t)==='r'?'red':'black';
    if(color!==need){ sendState(socket,t,socket.data.seat||'spectate'); return; }
    const idx=t.moves.length;
    t.moves.push({fr:m.fr,fc:m.fc,tr:m.tr,tc:m.tc});
    socket.to(t.id).emit('move',{fr:m.fr,fc:m.fc,tr:m.tr,tc:m.tc,by:color,idx});
  });

  socket.on('chat', p=>{
    const t=tables.get(socket.data.tableId);
    const text=p&&String(p.text||'').slice(0,300);
    if(t&&text) io.to(t.id).emit('chat',{name:socket.data.name||'访客',seat:socket.data.seat,text,ts:Date.now()});
  });

  socket.on('resign', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t) return;
    const color=colorBySid(t,socket.id);
    if(!color) return;
    t.status='over';
    io.to(t.id).emit('table:over',{reason:(color==='red'?'红方':'黑方')+'认输',winner:color==='red'?'black':'red'});
    pushLobby();
  });

  socket.on('undo:request', ()=>{ const t=tables.get(socket.data.tableId); if(!t||!colorBySid(t,socket.id))return; socket.to(t.id).emit('undo:request'); });
  socket.on('undo:reject',  ()=>{ const t=tables.get(socket.data.tableId); if(t) socket.to(t.id).emit('undo:reject'); });
  socket.on('undo:accept',  ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t||!t.moves.length)return;
    t.moves.pop(); resyncAll(t);
    io.to(t.id).emit('chat',{name:'系统',seat:'',text:'双方同意，悔棋一手',ts:Date.now()});
    pushLobby();
  });
  socket.on('draw:request', ()=>{ const t=tables.get(socket.data.tableId); if(!t||!colorBySid(t,socket.id))return; socket.to(t.id).emit('draw:request'); });
  socket.on('draw:reject',  ()=>{ const t=tables.get(socket.data.tableId); if(t) socket.to(t.id).emit('draw:reject'); });
  socket.on('draw:accept',  ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t)return;
    t.status='over'; io.to(t.id).emit('table:over',{reason:'双方议和，和棋',winner:null}); pushLobby();
  });

  socket.on('timeout', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t) return;
    const color=colorBySid(t,socket.id);
    if(!color) return;
    t.status='over';
    io.to(t.id).emit('table:over',{reason:(color==='red'?'红方':'黑方')+'超时',winner:color==='red'?'black':'red'});
    pushLobby();
  });

  socket.on('disconnect', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t){ pushLobby(); return; }
    const color=colorBySid(t,socket.id);
    t.spectators.delete(socket.id);
    if(color){
      const sid=socket.id;
      const timer=setTimeout(()=>{
        recoTimers.delete(sid);
        if(clearSeat(t,sid)){
          t.ready[color]=false;
          if(t.status==='playing') t.status='waiting';
          broadcastRoom(t);
          if(!t.seats.red&&!t.seats.black&&t.spectators.size===0) tables.delete(t.id);
          pushLobby();
        }
      }, 8000);
      recoTimers.set(sid,{timer,tableId:t.id,pid:socket.data.pid});
    }
    broadcastRoom(t);
    pushLobby(); pushOnline();
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT, ()=>console.log('立山斋象棋室 v3 running on :'+PORT));
