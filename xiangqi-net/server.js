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
const AI_NAME = '立山AI';
const mkReady   = () => ({ red:false, black:false });

const summary = t => ({
  id:t.id, name:t.name,
  red:   t.aiSeat==='red'   ? AI_NAME : (t.seats.red   ? t.seats.red.name   : null),
  black: t.aiSeat==='black' ? AI_NAME : (t.seats.black ? t.seats.black.name : null),
  spectators: t.spectators.size,
  status:t.status, moves:t.moves.length,
  ready:{...t.ready}, options:{...t.options},
  aiSeat:t.aiSeat, aiLevel:t.aiLevel              // 哪一方是AI、棋力
});
const MIN_TABLES = 10;      // 大厅常驻桌数（不足补齐，可扩充）
const MAX_TABLES = 60;      // 上限，防止无限建桌撑爆内存
function ensureMinTables(){
  // 空闲(无人)的桌数
  let idle = 0;
  for(const t of tables.values()){
    if(!t.seats.red && !t.seats.black && t.spectators.size===0) idle++;
  }
  // 总数不足 MIN_TABLES 时补空桌
  while(tables.size < MIN_TABLES){
    const id=newId();
    tables.set(id,{
      id, name:'棋桌 '+String(tables.size+1),
      seats:{red:null,black:null}, spectators:new Set(),
      moves:[], status:'waiting', ready:mkReady(), options:mkOptions(),
      aiSeat:null, aiLevel:6
    });
  }
}
const lobbyList  = ()  => { ensureMinTables(); return [...tables.values()].map(summary); };
const pushLobby  = ()  => io.to('lobby').emit('lobby:list', lobbyList());
const playersMsg = (t,extra) => ({
  red:   t.aiSeat==='red'   ? AI_NAME : (t.seats.red   ? t.seats.red.name   : null),
  black: t.aiSeat==='black' ? AI_NAME : (t.seats.black ? t.seats.black.name : null),
  spectators: t.spectators.size, status:t.status,
  ready: { ...t.ready }, aiSeat:t.aiSeat, aiLevel:t.aiLevel, ...extra
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
    seats:{ red: t.aiSeat==='red'?AI_NAME:(t.seats.red?.name||null), black: t.aiSeat==='black'?AI_NAME:(t.seats.black?.name||null) },
    moves:t.moves, turn:turnOf(t), status:t.status,
    options:{ ...t.options }, ready:{ ...t.ready },
    aiSeat:t.aiSeat, aiLevel:t.aiLevel
  });
}
function resyncAll(t){
  const room=io.sockets.adapter.rooms.get(t.id);
  if(!room)return;
  for(const sid of room){ const sk=io.sockets.sockets.get(sid); if(sk) sendState(sk,t,sk.data.seat||'spectate'); }
}
function broadcastRoom(t){ io.to(t.id).emit('table:players', playersMsg(t)); }
// 同一个人（PID）只能占一个座位：入座前先清掉他在别桌的座位
function releaseElsewhere(pid, keepTableId){
  for(const t of tables.values()){
    if(t.id===keepTableId) continue;
    let changed=false;
    if(t.seats.red   && t.seats.red.pid===pid)  { t.seats.red=null;   t.ready.red=false;   changed=true; }
    if(t.seats.black && t.seats.black.pid===pid){ t.seats.black=null; t.ready.black=false; changed=true; }
    if(changed){
      if(t.status==='playing') t.status='waiting';
      broadcastRoom(t);
      if(!t.seats.red && !t.seats.black && t.spectators.size===0){ t.moves=[]; t.status='waiting'; t.ready=mkReady(); t.options=mkOptions(); t.aiSeat=null; }
    }
  }
}
function pushOnline(){
  const room=io.sockets.adapter.rooms.get('lobby');
  const names=[];
  if(room){
    for(const sid of room){
      const sk=io.sockets.sockets.get(sid);
      if(sk && sk.data.name) names.push(sk.data.name);
    }
  }
  io.to('lobby').emit('lobby:online', { count: room?room.size:0, names });
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
    const text=p&&String(p.text||'').trim().slice(0,200);
    if(!text) return;
    const now=Date.now();
    if(now-(socket.data.lastLobbyChat||0) < 1200) return;   // 限流
    socket.data.lastLobbyChat=now;
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
    if(!t.seats.red && !t.seats.black){ t.aiSeat=null; t.ready=mkReady(); }   // 无人则AI也退场
    socket.leave(t.id);
    socket.data.tableId=null; socket.data.seat=null;
    socket.join('lobby');
    if(t.status==='playing') t.status='waiting';
    broadcastRoom(t);
    if(!t.seats.red&&!t.seats.black&&t.spectators.size===0){ t.moves=[]; t.status='waiting'; t.ready=mkReady(); t.options=mkOptions(); t.aiSeat=null; }
    pushLobby();
  });

  socket.on('table:create', (p,ack)=>{
    if(tables.size>=MAX_TABLES){
      if(typeof ack==='function') ack({ok:false,err:'棋室已满，请先用现有空桌'});
      return;
    }
    const id=newId();
    tables.set(id,{
      id, name:(p?.name ? String(p.name).slice(0,30):('棋桌 '+id.slice(-3))),
      seats:{red:null,black:null}, spectators:new Set(),
      moves:[], status:'waiting',
      ready:mkReady(), options:mkOptions(),
      aiSeat:null, aiLevel:6            // aiSeat: 'red'|'black'|null —— 哪一方由AI担任
    });
    pushLobby();
    if(typeof ack==='function') ack({ok:true,id});
  });

  socket.on('table:join', (p,ack)=>{
    const t=tables.get(p?.tableId);
    if(!t){ if(typeof ack==='function') ack({ok:false,err:'桌子不存在'}); return; }

    const pid  = (p?.playerId?String(p.playerId).slice(0,40):('anon'+socket.id));
    const name = (p?.name    ?String(p.name).slice(0,20)    :('访客'+socket.id.slice(0,4)));
    // 坐下后仍留在大厅房间，以便继续接收大厅列表与闲聊

    // 取消断线计时器（强制刷新重连）
    for(const [sid,d] of recoTimers.entries()){
      if(d.pid===pid && d.tableId===p.tableId){ clearTimeout(d.timer); recoTimers.delete(sid); break; }
    }

    // 同一个人只能占一个座位：先释放他在别桌的座位
    releaseElsewhere(pid, t.id);

    let seat=(p?.seat)||'auto';
    const existing=colorByPid(t,pid);
    let taken=false;
    if(existing){
      seat=existing;                        // 本桌重连，回原座
    } else {
      if(seat==='auto') seat = !t.seats.red ? 'red' : (!t.seats.black ? 'black' : 'spectate');
      // 座位被别人占了才转观战（同 PID 已在上面处理）
      if(seat==='red'   && t.seats.red   && t.seats.red.pid!==pid)  { seat='spectate'; taken=true; }
      if(seat==='black' && t.seats.black && t.seats.black.pid!==pid){ seat='spectate'; taken=true; }
    }
    // 清掉本桌可能残留的同 PID 记录，避免一人占两座
    if(t.seats.red   && t.seats.red.pid===pid   && seat!=='red')   { t.seats.red=null;   t.ready.red=false; }
    if(t.seats.black && t.seats.black.pid===pid && seat!=='black') { t.seats.black=null; t.ready.black=false; }
    t.spectators.delete(socket.id);

    if     (seat==='red')   t.seats.red   ={pid,name,sid:socket.id};
    else if(seat==='black') t.seats.black ={pid,name,sid:socket.id};
    else                   { seat='spectate'; t.spectators.add(socket.id); }

    socket.data.tableId=t.id; socket.data.seat=seat; socket.data.pid=pid; socket.data.name=name;
    socket.join(t.id);

    sendState(socket,t,seat);
    broadcastRoom(t);
    pushLobby();
    if(typeof ack==='function') ack({ok:true,seat,taken});
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

  // 邀请 AI 入座（坐在空着的那一方）
  socket.on('table:inviteAI', (p)=>{
    const t=tables.get(socket.data.tableId);
    if(!t) return;
    const mySeatColor=colorBySid(t,socket.id);
    if(!mySeatColor) return;                        // 只有在座玩家能邀请
    const other = mySeatColor==='red' ? 'black' : 'red';
    if(t.seats[other]) return;                      // 对面有真人，不能请AI
    t.aiSeat = other;
    t.aiLevel = Math.min(9, Math.max(1, parseInt(p?.level)||6));
    t.ready[other]=true;                            // AI 永远处于就绪
    broadcastRoom(t); pushLobby();
    io.to(t.id).emit('chat',{name:'系统',seat:'',text:AI_NAME+'（'+t.aiLevel+'级）已入座，点「开始对局」即可开始',ts:Date.now()});
  });

  // 请 AI 离座
  socket.on('table:dismissAI', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t||!t.aiSeat) return;
    if(!colorBySid(t,socket.id)) return;
    t.ready[t.aiSeat]=false;
    t.aiSeat=null;
    broadcastRoom(t); pushLobby();
  });

  // 客户端判出胜负后上报（将死/困毙/长将/重复局面等）
  socket.on('table:gameover',(p)=>{
    const t=tables.get(socket.data.tableId);
    if(!t || t.status==='over') return;
    if(!colorBySid(t,socket.id)) return;          // 只信在座玩家的上报
    t.status='over';
    const reason=String(p?.reason||'对局结束').slice(0,60);
    io.to(t.id).emit('table:over',{reason,winner:null});
    pushLobby();
  });

  // 再来一局：重置棋局，双方留座（红黑互换，轮流先手更公平）
  socket.on('table:rematch', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t) return;
    if(!colorBySid(t,socket.id) && !t.aiSeat) return;
    t.moves=[];
    t.status='playing';
    // 红黑互换
    const r=t.seats.red, b=t.seats.black;
    t.seats.red=b; t.seats.black=r;
    if(t.aiSeat) t.aiSeat = (t.aiSeat==='red')?'black':'red';
    // 更新每个 socket 的 seat 记录
    for(const sid of (io.sockets.adapter.rooms.get(t.id)||[])){
      const sk=io.sockets.sockets.get(sid);
      if(!sk) continue;
      const c=colorBySid(t,sid);
      if(c) sk.data.seat=c;
    }
    t.ready=mkReady();
    if(t.aiSeat) t.ready[t.aiSeat]=true;
    if(t.seats.red) t.ready.red=true;
    if(t.seats.black) t.ready.black=true;
    io.to(t.id).emit('game:restart',{ options:{...t.options}, aiSeat:t.aiSeat, aiLevel:t.aiLevel });
    resyncAll(t); broadcastRoom(t); pushLobby();
    io.to(t.id).emit('chat',{name:'系统',seat:'',text:'再来一局，红黑互换',ts:Date.now()});
  });

  // 准备好了（双方都准备后发 game:start）
  socket.on('table:ready', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t) return;
    const seat=socket.data.seat;
    if(seat!=='red'&&seat!=='black') return;
    t.ready[seat]=true;
    broadcastRoom(t); pushLobby();
    const redOK   = !!t.seats.red   || t.aiSeat==='red';
    const blackOK = !!t.seats.black || t.aiSeat==='black';
    if(t.ready.red && t.ready.black && redOK && blackOK){
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
    // 轮到 AI 时，允许在座的真人代 AI 发着法（AI 计算跑在该玩家浏览器里）
    const aiTurn = (t.aiSeat && need===t.aiSeat);
    if(color!==need && !aiTurn){ sendState(socket,t,socket.data.seat||'spectate'); return; }
    // 坐标合法性校验：行 0-9、列 0-8，非法数据直接丢弃并让该端重同步
    const ok = [m.fr,m.tr].every(v=>Number.isInteger(v)&&v>=0&&v<=9)
            && [m.fc,m.tc].every(v=>Number.isInteger(v)&&v>=0&&v<=8);
    if(!ok){ sendState(socket,t,socket.data.seat||'spectate'); return; }
    const idx=t.moves.length;
    t.moves.push({fr:m.fr,fc:m.fc,tr:m.tr,tc:m.tc});
    socket.to(t.id).emit('move',{fr:m.fr,fc:m.fc,tr:m.tr,tc:m.tc,by:color,idx});
  });

  socket.on('chat', p=>{
    const t=tables.get(socket.data.tableId);
    const text=p&&String(p.text||'').trim().slice(0,300);
    if(!t||!text) return;
    const now=Date.now();
    if(now-(socket.data.lastChat||0) < 1200) return;      // 限流，防刷屏
    socket.data.lastChat=now;
    io.to(t.id).emit('chat',{name:socket.data.name||'访客',seat:socket.data.seat,text,ts:now});
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
          if(!t.seats.red && !t.seats.black){ t.aiSeat=null; t.ready=mkReady(); }
          if(t.status==='playing') t.status='waiting';
          broadcastRoom(t);
          if(!t.seats.red&&!t.seats.black&&t.spectators.size===0){ t.moves=[]; t.status='waiting'; t.ready=mkReady(); t.options=mkOptions(); t.aiSeat=null; }
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
