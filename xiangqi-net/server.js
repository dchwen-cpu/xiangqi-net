// 立山象棋室 · 服务器 v3  — 候棋室 + 游戏选项 + 双方准备后开局
const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');
const { router: authRouter } = require('./auth');   // 认证路由（注册/登录/JWT）
const dbx = require('./db');                          // 数据库（访问计数等直接查询）

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:'*' } });
app.use(express.json());   // 解析 /auth 等 POST 请求的 JSON body
// 只有象棋（Fairy-Stockfish WASM 多线程）需要这两个隔离头，覆盖两个域名下的 /xiangqi：
// 在线棋盘 + 立山斋单机象棋都靠它跑 SharedArrayBuffer。围棋(纯JS / tfjs-WebGL)、首页、
// 博客都不需要隔离，也不发——否则 COEP 会挡住围棋的 Google 字体和 CDN 权重。
app.use((req,res,next)=>{
  if (req.path.startsWith('/xiangqi')) {
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  }
  next();
});

// 两个站共用的静态服务选项（MIME + 缓存策略）
const staticOpts = {
  etag: true,
  setHeaders: (res, fp) => {
    // 正确的 MIME，否则浏览器拒绝执行/实例化
    if (fp.endsWith('.wasm')) res.setHeader('Content-Type','application/wasm');
    if (fp.endsWith('.nnue')) res.setHeader('Content-Type','application/octet-stream');
    if (fp.endsWith('.js'))   res.setHeader('Content-Type','text/javascript; charset=utf-8');

    // 经常改动的文件：每次都回服务器核对，避免改了代码看到的还是旧版
    // （no-cache 不是"不缓存"，是"用之前必须先问服务器有没有更新"，
    //   没更新就返回 304，几乎不耗流量）
    if (/\.(html|js)$/.test(fp)) {
      res.setHeader('Cache-Control','no-cache');
    }
    // 体积大且几乎不变的：放心长期缓存
    else if (/\.(wasm|nnue|png|m4a|mp3)$/.test(fp)) {
      res.setHeader('Cache-Control','public, max-age=604800');   // 7 天
    }
  }
};

// 判定：请求来自立山斋个人站域名，还是棋牌室
function isStudio(req){ return req.hostname.includes('lishanzhai'); }

// 按域名分发到各自的静态根，两站 URL 命名空间彻底隔开、互不串门：
//   lishanzhai.com  → studio/   （立山斋个人站）
//   其它（含 chinesechessonline.com、xiangqi-net）→ public/  （棋牌室）
const gameStatic   = express.static(path.join(__dirname,'public'), staticOpts);
const studioStatic = express.static(path.join(__dirname,'studio'), staticOpts);
app.use((req, res, next) => isStudio(req) ? studioStatic(req, res, next) : gameStatic(req, res, next));
// 大厅移到 /lobby；仅棋牌室域名下发，立山斋站没有大厅
app.get('/lobby', (req,res,next) => {
  if (isStudio(req)) return next();
  res.sendFile(path.join(__dirname,'public','lobby.html'));
});

app.use('/auth', authRouter);   // /auth/register  /auth/login  /auth/me（同源，无需 CORS）

// 访问计数：门厅每次打开调一次，同访客当天只记一次，返回累计访问数
app.post('/api/visits', (req, res) => {
  try {
    const visitorId = (String(req.body?.visitorId || '').slice(0, 40)) || 'anon';
    res.json(dbx.recordVisit(visitorId));
  } catch (e) {
    console.error('[visits]', e);
    res.status(500).json({ error: 'visits failed' });
  }
});

// 引擎文件自检页：浏览器打开 /engine-check 即可看到服务器上真实存在哪些文件
app.get('/engine-check', (_,res)=>{
  const fs=require('fs');
  const dir=path.join(__dirname,'public','xiangqi');
  const need=[
    ['index.html','棋盘主程序'],
    ['netplay.js','联网层'],
    ['stockfish.js','强引擎主文件（4-9级必需）'],
    ['stockfish.wasm','强引擎核心（最容易漏传）'],
    ['xiangqi-c07e94a5c7cb.nnue','神经网络（7-9级必需）']
  ];
  let files=[];
  try{ files=fs.readdirSync(dir); }catch(e){ files=null; }
  let html='<meta charset="utf-8"><body style="font:14px/1.8 system-ui;padding:24px;max-width:760px;margin:auto">';
  html+='<h2>引擎文件自检</h2><p style="color:#666">目录：public/xiangqi/</p>';
  if(files===null){
    html+='<p style="color:#c00"><b>目录不存在</b>，请确认 public/xiangqi/ 路径正确。</p>';
  } else {
    html+='<table cellpadding="8" style="border-collapse:collapse;width:100%">';
    html+='<tr style="background:#eee"><th align="left">文件</th><th align="left">状态</th><th align="left">大小</th><th align="left">说明</th></tr>';
    for(const [f,desc] of need){
      const hit=files.find(x=>x.toLowerCase()===f.toLowerCase());
      let size='-';
      if(hit){ try{ size=(fs.statSync(path.join(dir,hit)).size/1048576).toFixed(2)+' MB'; }catch(e){} }
      html+='<tr style="border-bottom:1px solid #ddd"><td><code>'+f+'</code></td>'
          +'<td style="color:'+(hit?'#080':'#c00')+'"><b>'+(hit?'存在':'缺失')+'</b></td>'
          +'<td>'+size+'</td><td style="color:#666">'+desc+'</td></tr>';
    }
    html+='</table>';
    html+='<h3>该目录下实际所有文件（'+files.length+' 个）</h3>';
    html+='<pre style="background:#f6f6f6;padding:12px;overflow:auto">'
        + files.map(f=>{ let sz=''; try{ sz=' — '+(fs.statSync(path.join(dir,f)).size/1024).toFixed(0)+' KB'; }catch(e){} return f+sz; }).join('\n')
        + '</pre>';
  }
  html+='<p><a href="/lobby">← 返回棋室</a></p></body>';
  res.type('html').send(html);
});

const tables     = new Map();
const recoTimers = new Map();
const users      = new Map();   // pid -> {pid,name,sid,status}
// 人机对局转播：服务器只当转播台，不做任何裁决。
// 棋局全在对局者浏览器里跑，他推快照上来，服务器原样转给旁观者。
// 因为只有一个真相来源（对局者本地），不存在与服务器状态错位的可能。
const soloGames  = new Map();   // id -> {id,name,level,sid,state,watchers,ts}
let   soloSeq    = 1;
const watchReqs  = new Map();   // reqId -> {soloId,sid,name,ts} 人机对局的观战请求
const tableWatchReqs = new Map();  // reqId -> {tableId,sid,name,votes,ts} 真人对局的观战请求
const invites    = new Map();   // inviteId -> {tableId,fromPid,toPid,ts}
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
const soloList   = ()  => [...soloGames.values()].map(g=>({
  id:g.id, name:g.name, level:g.level, watchers:g.watchers||0
}));
const pushLobby  = ()  => {
  io.to('lobby').emit('lobby:list', lobbyList());
  io.to('lobby').emit('lobby:solo', soloList());
};
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
// 把某局的观战情况（人数 + 名单）推给该局所有人（对局者与旁观者都收）
function pushSoloWatchers(id){
  const g = soloGames.get(id);
  if(!g) return;
  const room = io.sockets.adapter.rooms.get('solo:'+id);
  const names = [];
  if(room){
    for(const sid of room){
      const sk = io.sockets.sockets.get(sid);
      if(sk && sk.id !== g.sid) names.push(sk.data.name || '访客');
    }
  }
  g.watchers = names.length;
  io.to('solo:'+id).emit('solo:watchers', { count: names.length, names, player: g.name, level: g.level });
}

function pushUsers(){
  const list=[...users.values()].map(u=>({pid:u.pid,name:u.name,status:u.status}));
  io.to('lobby').emit('lobby:users', list);
}
function findFreeTable(){
  for(const t of tables.values()){
    if(!t.seats.red && !t.seats.black && t.spectators.size===0 && !t.aiSeat) return t;
  }
  return null;
}
function setUserStatus(pid,st){
  const u=users.get(pid);
  if(u){ u.status=st; pushUsers(); }
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
    if(p&&p.name) socket.data.name=String(p.name).slice(0,20);
    if(p&&p.playerId) socket.data.pid=String(p.playerId).slice(0,40);
    socket.join('lobby');
    // 登记为在厅棋友（供他人邀请）
    if(socket.data.pid){
      users.set(socket.data.pid,{
        pid:socket.data.pid, name:socket.data.name||'访客',
        sid:socket.id, status: socket.data.tableId?'对局中':'在厅'
      });
    }
    socket.emit('lobby:list', lobbyList());
    socket.emit('lobby:solo', soloList());
    pushOnline(); pushUsers();
  });

  // ── 直接约 AI：不必先坐下，选好等级即刻开局 ──
  socket.on('lobby:playAI',(p,ack)=>{
    const lv=Math.min(9,Math.max(1,parseInt(p?.level)||6));
    // 指定了桌号就用那张（必须是空桌），否则自动找一张
    const reqPid=socket.data.pid||('anon'+socket.id);
    let t=null;
    if(p&&p.tableId){
      const cand=tables.get(p.tableId);
      // 空桌，或桌上只有请求者自己（坐着等人时改叫电脑）
      const onlyMe = (!cand?.seats.red || cand.seats.red.pid===reqPid)
                  && (!cand?.seats.black || cand.seats.black.pid===reqPid);
      if(cand && onlyMe && !cand.aiSeat) t=cand;
    }
    if(!t) t=findFreeTable();
    if(!t){ if(typeof ack==='function') ack({ok:false,err:'该桌已被占用，请换一张'}); return; }
    const pid=reqPid;
    // 尊重已有座位：如果他已经坐在这桌的某一侧（比如先坐了黑），
    // 就让电脑坐对面，而不是把人强行拽到红位。没坐过则默认执红。
    let mySeat='red';
    if(t.seats.black && t.seats.black.pid===pid) mySeat='black';
    else if(t.seats.red && t.seats.red.pid===pid) mySeat='red';
    const aiSide = (mySeat==='red') ? 'black' : 'red';

    releaseElsewhere(pid,t.id);
    t.seats[mySeat]={pid,name:socket.data.name||'访客',sid:socket.id};
    t.seats[aiSide]=null;
    t.aiSeat=aiSide; t.aiLevel=lv;
    t.moves=[]; t.status='playing';
    t.ready={red:true,black:true};
    socket.data.tableId=t.id; socket.data.seat=mySeat;
    socket.join(t.id);
    setUserStatus(pid,'对局中');
    sendState(socket,t,mySeat);
    socket.emit('game:start',{options:{...t.options},aiSeat:t.aiSeat,aiLevel:t.aiLevel});
    pushLobby();
    if(typeof ack==='function') ack({ok:true,tableId:t.id,seat:mySeat});
  });

  // ── 邀请真人对弈 ──
  socket.on('invite:send',(p,ack)=>{
    const target=users.get(p&&p.toPid);
    if(!target){ if(typeof ack==='function') ack({ok:false,err:'对方已离开'}); return; }
    if(target.pid===socket.data.pid){ if(typeof ack==='function') ack({ok:false,err:'不能邀请自己'}); return; }
    const t=findFreeTable();
    if(!t){ if(typeof ack==='function') ack({ok:false,err:'暂无空桌'}); return; }
    const pid=socket.data.pid||('anon'+socket.id);
    releaseElsewhere(pid,t.id);
    t.seats.red={pid,name:socket.data.name||'访客',sid:socket.id};
    t.aiSeat=null; t.moves=[]; t.status='waiting'; t.ready=mkReady();
    socket.data.tableId=t.id; socket.data.seat='red';
    socket.join(t.id);
    const inviteId='i'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    invites.set(inviteId,{tableId:t.id,fromPid:pid,toPid:target.pid,ts:Date.now()});
    setTimeout(()=>invites.delete(inviteId),60000);      // 邀请 60 秒过期
    io.to(target.sid).emit('invite:recv',{
      inviteId, fromName:socket.data.name||'访客', tableName:t.name
    });
    sendState(socket,t,'red');
    pushLobby(); pushUsers();
    if(typeof ack==='function') ack({ok:true,tableId:t.id});
  });

  socket.on('invite:accept',(p)=>{
    const inv=invites.get(p&&p.inviteId);
    if(!inv) return;
    invites.delete(p.inviteId);
    const t=tables.get(inv.tableId);
    if(!t){ socket.emit('invite:gone'); return; }
    const pid=socket.data.pid||('anon'+socket.id);
    releaseElsewhere(pid,t.id);
    t.seats.black={pid,name:socket.data.name||'访客',sid:socket.id};
    socket.data.tableId=t.id; socket.data.seat='black';
    socket.join(t.id);
    setUserStatus(pid,'已坐下');
    setUserStatus(inv.fromPid,'已坐下');
    sendState(socket,t,'black');
    broadcastRoom(t); pushLobby(); pushUsers();
    io.to(t.id).emit('chat',{name:'系统',seat:'',text:'双方已入座，点「开始对局」即可开始',ts:Date.now()});
  });

  socket.on('invite:decline',(p)=>{
    const inv=invites.get(p&&p.inviteId);
    if(!inv) return;
    invites.delete(p.inviteId);
    const from=users.get(inv.fromPid);
    if(from) io.to(from.sid).emit('invite:declined',{name:socket.data.name||'对方'});
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
    setUserStatus(socket.data.pid,'在厅');
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
    else {
      // 观战真人对局需双方在座棋手同意；桌上还没坐满时无人可问，直接放行
      seat='spectate';
      const needAsk = !!(t.seats.red && t.seats.black);
      if(needAsk){
        const reqId='t'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
        tableWatchReqs.set(reqId,{ tableId:t.id, sid:socket.id, name, votes:{}, ts:Date.now() });
        setTimeout(()=>{
          if(tableWatchReqs.has(reqId)){
            tableWatchReqs.delete(reqId);
            io.to(socket.id).emit('watch:result',{ok:false,err:'棋手未回应，请稍后再试'});
          }
        }, 60000);
        io.to(t.seats.red.sid).emit('watch:ask',{ reqId, name, table:true });
        io.to(t.seats.black.sid).emit('watch:ask',{ reqId, name, table:true });
        if(typeof ack==='function') ack({ok:true, pending:true, seat:'spectate'});
        return;                       // 等批准，先不入座
      }
      t.spectators.add(socket.id);
    }

    socket.data.tableId=t.id; socket.data.seat=seat; socket.data.pid=pid; socket.data.name=name;
    socket.join(t.id);
    // 入座只是"坐下"，真正开局(点▶开始)后才算"对局中"；重连进已在进行的对局则直接显示对局中
    const seatStatus = (seat==='spectate') ? '观战' : (t.status==='playing' ? '对局中' : '已坐下');
    if(users.has(pid)){ users.get(pid).sid=socket.id; users.get(pid).name=name; users.get(pid).status=seatStatus; pushUsers(); }
    else { users.set(pid,{pid,name,sid:socket.id,status:seatStatus}); pushUsers(); }

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
  // 「▶ 开始」：双方都已入座时，任一方点一次即可开局（不需要另一方也点）
  socket.on('table:ready', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t) return;
    const seat=socket.data.seat;
    if(seat!=='red'&&seat!=='black') return;
    const redOK   = !!t.seats.red   || t.aiSeat==='red';
    const blackOK = !!t.seats.black || t.aiSeat==='black';
    if(!redOK || !blackOK) return;          // 对面还空着，不能开始
    t.ready.red=true; t.ready.black=true;   // 一人点击即视为双方就绪
    t.status='playing';
    if(t.seats.red)   setUserStatus(t.seats.red.pid,'对局中');
    if(t.seats.black) setUserStatus(t.seats.black.pid,'对局中');
    io.to(t.id).emit('game:start', { options:{...t.options} });
    broadcastRoom(t); pushLobby();
  });

  socket.on('table:unready', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t) return;
    const seat=socket.data.seat;
    if(seat!=='red'&&seat!=='black') return;
    t.ready[seat]=false;
    broadcastRoom(t); pushLobby();
  });

  // ── 人机对局转播 ──
  socket.on('solo:begin', (p, ack)=>{
    const id = 's'+(soloSeq++).toString(36)+Date.now().toString(36).slice(-3);
    soloGames.set(id, {
      id,
      name : (p&&p.name) ? String(p.name).slice(0,20) : '访客',
      level: Math.min(9, Math.max(1, parseInt(p&&p.level)||6)),
      sid  : socket.id, state:null, watchers:0, ts:Date.now()
    });
    socket.data.soloId = id;
    socket.join('solo:'+id);
    pushSoloWatchers(id);
    pushLobby();
    if(typeof ack==='function') ack({ok:true, id});
  });

  // 对局者推来的棋盘快照，原样转给旁观者（不校验、不改动）
  socket.on('solo:push', (p)=>{
    const g = soloGames.get(socket.data.soloId);
    if(!g || g.sid!==socket.id) return;
    g.state = p; g.ts = Date.now();
    if(p && p.level) g.level = p.level;
    socket.to('solo:'+g.id).emit('solo:state', p);
  });

  // 观战人机对局：要先征得对局者同意。电脑一方无需征询（默认同意），
  // 所以只要执棋的那位点了「同意」即可入场。
  socket.on('solo:watch', (p, ack)=>{
    const g = soloGames.get(p && p.id);
    if(!g){ if(typeof ack==='function') ack({ok:false,err:'该对局已结束'}); return; }
    const reqId = 'w'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    const who   = socket.data.name || '访客';
    watchReqs.set(reqId, { soloId:g.id, sid:socket.id, name:who, ts:Date.now() });
    setTimeout(()=>{                                  // 60 秒无回应自动作废
      if(watchReqs.has(reqId)){
        watchReqs.delete(reqId);
        io.to(socket.id).emit('watch:result', { ok:false, err:'对方未回应，请稍后再试' });
      }
    }, 60000);
    io.to(g.sid).emit('watch:ask', { reqId, name:who });
    if(typeof ack==='function') ack({ok:true, pending:true, name:g.name, level:g.level});
  });

  // 真人对局的观战答复：红黑两位都同意才放行，任一方拒绝即作罢
  socket.on('watch:replyTable', (p)=>{
    const req = tableWatchReqs.get(p && p.reqId);
    if(!req) return;
    const t = tables.get(req.tableId);
    const viewer = io.sockets.sockets.get(req.sid);
    if(!t || !viewer){ tableWatchReqs.delete(p.reqId); return; }
    const color = colorBySid(t, socket.id);
    if(!color) return;                              // 只有在座棋手能表态
    if(!p.accept){
      tableWatchReqs.delete(p.reqId);
      viewer.emit('watch:result',{ok:false,err:'棋手谢绝了观战请求'});
      return;
    }
    req.votes[color] = true;
    if(req.votes.red && req.votes.black){           // 双方都同意
      tableWatchReqs.delete(p.reqId);
      t.spectators.add(viewer.id);
      viewer.data.tableId = t.id;
      viewer.data.seat = 'spectate';
      viewer.join(t.id);
      sendState(viewer, t, 'spectate');
      broadcastRoom(t); pushLobby();
      viewer.emit('watch:result',{ok:true});
    } else {
      viewer.emit('watch:result',{ok:false, waiting:true, err:'已获一方同意，等待另一位…'});
    }
  });

  // 对局者的答复
  socket.on('watch:reply', (p)=>{
    const req = watchReqs.get(p && p.reqId);
    if(!req) return;
    watchReqs.delete(p.reqId);
    const g = soloGames.get(req.soloId);
    const viewer = io.sockets.sockets.get(req.sid);
    if(!g || !viewer){ return; }
    if(g.sid !== socket.id) return;                   // 只有对局者本人能批准
    if(p.accept){
      viewer.data.watchId = g.id;
      viewer.join('solo:'+g.id);
      pushSoloWatchers(g.id);
      pushLobby();
      viewer.emit('watch:result', { ok:true, name:g.name, level:g.level });
      if(g.state) viewer.emit('solo:state', g.state);
    } else {
      viewer.emit('watch:result', { ok:false, err:'对方谢绝了观战请求' });
    }
  });

  socket.on('solo:unwatch', ()=>{
    const id = socket.data.watchId;
    if(!id) return;
    socket.leave('solo:'+id);
    socket.data.watchId = null;
    if(soloGames.get(id)){ pushSoloWatchers(id); pushLobby(); }
  });

  socket.on('solo:end', ()=>{
    const id = socket.data.soloId;
    if(!id) return;
    io.to('solo:'+id).emit('solo:over');
    soloGames.delete(id);
    socket.data.soloId = null;
    pushLobby();
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
  // 与电脑对弈：一次悔两步（撤掉电脑的应招 + 自己那一步），一键回到自己可重新落子的局面
  socket.on('undo:ai', ()=>{
    const t=tables.get(socket.data.tableId);
    if(!t||!t.aiSeat||!t.moves.length) return;
    if(!colorBySid(t,socket.id)) return;
    t.moves.pop();
    if(t.moves.length) t.moves.pop();
    resyncAll(t);
    io.to(t.id).emit('chat',{name:'系统',seat:'',text:'已悔棋一手',ts:Date.now()});
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
    // 人机对局转播的清理：对局者掉线则该转播结束；旁观者掉线则更新人数
    if(socket.data.soloId){
      io.to('solo:'+socket.data.soloId).emit('solo:over');
      soloGames.delete(socket.data.soloId);
      socket.data.soloId = null;
    }
    if(socket.data.watchId){
      const wid = socket.data.watchId;
      socket.data.watchId = null;
      setTimeout(()=>{ if(soloGames.get(wid)){ pushSoloWatchers(wid); pushLobby(); } }, 50);
    }

    // 从在厅名单移除（仅当该 pid 的当前连接就是本 socket）
    const upid=socket.data.pid;
    if(upid && users.get(upid) && users.get(upid).sid===socket.id){
      setTimeout(()=>{
        const u=users.get(upid);
        if(u && u.sid===socket.id){ users.delete(upid); pushUsers(); }
      }, 6000);   // 给刷新重连留缓冲
    }
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
