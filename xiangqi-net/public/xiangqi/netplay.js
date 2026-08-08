/* 立山象棋 · 联网层（服务器权威 + 幂等按序号 + 自动重同步 + 重连认人）
 * 加到象棋 index.html 末尾：<script src="netplay.js"></script>
 * 仅当 URL 带 ?table=... 时激活；否则离线版行为不变。
 */
(function(){
  var params = new URLSearchParams(location.search);
  var tableId = params.get('table');
  if (!tableId) return;
  var seatWanted = params.get('seat') || 'auto';
  var myName = params.get('name') || '访客';

  // 持久身份：重连也认得你（免费主机网络抖动会换 socket.id）
  // 每个标签页独立身份：同一浏览器开两个标签测试也不会互相顶座；同标签页重连/刷新仍保持
  var PID = sessionStorage.getItem('lsz_pid');
  if (!PID){ PID = 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('lsz_pid', PID); }

  var myColor = null, isSpectator = false, applyingRemote = false;
  var appliedCount = 0;                 // 本地已应用的着法数（用于按服务器序号幂等应用）
  window.__netMode = false;

  var s = document.createElement('script');
  s.src = '/socket.io/socket.io.js';
  s.onload = init;
  s.onerror = function(){ banner('无法加载对战组件，请确认已连到象棋室服务器'); };
  document.head.appendChild(s);

  var SOCK = null;
  function init(){
    var socket = io();
    SOCK = socket; window.__netSocket = socket;
    buildUI(socket);

    socket.on('connect', function(){                       // 首次连接 & 每次重连都重新入桌
      socket.emit('table:join', { tableId: tableId, seat: seatWanted, name: myName, playerId: PID });
    });
    socket.on('table:state', function(st){ setup(st, socket); });   // 每次收到都全量重同步（自愈）
    socket.on('move', function(m){
      if (!m || typeof m.idx !== 'number') return;
      if (m.idx === appliedCount){ applyRemote(m); appliedCount++; refreshTurn(); }
      else if (m.idx < appliedCount){ /* 已应用(含自己的回显) → 忽略 */ }
      else { socket.emit('sync:request'); }               // 落后了 → 请求全量重同步
    });
    socket.on('chat', function(msg){ addChat(msg); });
    socket.on('table:players', function(p){ setPlayers(p); });
    socket.on('table:over', function(o){ setStatus((o.reason||'') + '，对局结束'); });
    socket.on('disconnect', function(){ setStatus('连接中断，重连中…'); });
    socket.on('undo:request', function(){ if (confirm('对方请求悔棋一手，是否同意？')) socket.emit('undo:accept'); else socket.emit('undo:reject'); });
    socket.on('undo:reject', function(){ setStatus('对方拒绝了悔棋'); });
    socket.on('draw:request', function(){ if (confirm('对方提出和棋，是否同意？')) socket.emit('draw:accept'); else socket.emit('draw:reject'); });
    socket.on('draw:reject', function(){ setStatus('对方拒绝了和棋'); });
  }

  function setup(st, socket){
    var seat = st.seat;
    isSpectator = (seat === 'spectate');
    myColor = seat === 'red' ? 'r' : (seat === 'black' ? 'b' : null);

    skipIntro();
    try { if (typeof reset === 'function') reset(); } catch(e){}

    window.__netMode = true;
    try { mode = 'ai'; aiSide = isSpectator ? 'x' : (myColor === 'r' ? 'b' : 'r'); } catch(e){}

    if (typeof triggerAI === 'function' && !triggerAI.__net){
      var _t = triggerAI;
      window.triggerAI = function(){ if (window.__netMode) return; return _t.apply(this, arguments); };
      window.triggerAI.__net = true;
    }
    if (typeof makeMove === 'function' && !makeMove.__net){
      var _m = makeMove;
      window.makeMove = function(fr,fc,tr,tc){
        if (window.__netMode && isSpectator && !applyingRemote) return;    // 观战禁走
        if (window.__netMode && !applyingRemote && myColor && turn !== myColor) return; // 非你回合，禁走(保险)
        var r = _m(fr,fc,tr,tc);
        if (window.__netMode && !applyingRemote){
          appliedCount++;                                                  // 本地这步已应用
          socket.emit('move', { fr:fr, fc:fc, tr:tr, tc:tc });             // 序号由服务器分配
          refreshTurn();
        }
        return r;
      };
      window.makeMove.__net = true;
    }

    // 全量回放到当前局面
    applyingRemote = true;
    appliedCount = 0;
    try { (st.moves||[]).forEach(function(m){ makeMove(m.fr,m.fc,m.tr,m.tc); appliedCount++; }); } catch(e){}
    applyingRemote = false;
    try { turn = st.turn || 'r'; if (typeof draw === 'function') draw(); } catch(e){}

    injectNetDisable();
    hookNetButtons(socket);
    setPlayers(st.seats || {});
    refreshTurn();
  }

  // 联网时隐藏不适用的控件：对弈方式/棋力/残局/评测/重新开始（点了会打乱联机对局）
  function injectNetDisable(){
    if (document.getElementById('np-disable-style')) return;
    var st = document.createElement('style'); st.id = 'np-disable-style';
    st.textContent = '#mtrig-mode,#mtrig-level,#mtrig-red,#mtrig-black,#trig-mode,#trig-level,#trig-redlevel,#trig-blacklevel,#endgame-btn,#assess-btn,#restart{display:none!important}';
    document.head.appendChild(st);
  }
  function hookBtn(id, fn){
    var b = document.getElementById(id);
    if (b && !b.__nethook){
      b.addEventListener('click', function(e){ if (window.__netMode){ e.stopImmediatePropagation(); e.preventDefault(); fn(); } }, true);
      b.__nethook = true;
    }
  }
  // 悔棋 / 求和 改为向对方发起请求，对方同意才生效
  function hookNetButtons(socket){
    hookBtn('undo', function(){ if (isSpectator) return; socket.emit('undo:request'); setStatus('已请求悔棋，等待对方同意…'); });
    hookBtn('draw-btn', function(){ if (isSpectator) return; socket.emit('draw:request'); setStatus('已请求和棋，等待对方同意…'); });
  }

  function applyRemote(m){
    applyingRemote = true;
    try { makeMove(m.fr,m.fc,m.tr,m.tc); } catch(e){}
    applyingRemote = false;
    try { if (typeof draw === 'function') draw(); } catch(e){}
  }

  function refreshTurn(){
    if (isSpectator){ setStatus('观战中'); return; }
    if (typeof turn === 'undefined'){ return; }
    setStatus(turn === myColor ? '★ 轮到你走（' + (myColor==='r'?'红':'黑') + '）' : '… 等待对方走棋');
  }

  function skipIntro(){
    try {
      document.querySelectorAll('button, a, .btn').forEach(function(b){
        var tx = (b.textContent||'').trim();
        if (/^进\s*入$|^开始$|开\s*局|进入棋盘/.test(tx)) { try{ b.click(); }catch(e){} }
      });
    } catch(e){}
  }

  // —— UI：状态条 + 聊天 ——
  var elStatus, elPlayers, elChatLog, elChatIn;
  function buildUI(socket){
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:99999;background:#9d2c21;color:#f2e8d5;font:13px/1.6 "Songti SC",serif;padding:5px 12px;display:flex;gap:14px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    bar.innerHTML = '<b style="letter-spacing:.1em">立山象棋室</b><span id="np-players">—</span><span id="np-status" style="flex:1">连接中…</span>'
      + '<button id="np-resign" style="background:transparent;border:1px solid #f2e8d5;color:#f2e8d5;border-radius:4px;padding:2px 8px;cursor:pointer">认输</button>'
      + '<button id="np-chat-t" style="background:transparent;border:1px solid #f2e8d5;color:#f2e8d5;border-radius:4px;padding:2px 8px;cursor:pointer">聊天</button>'
      + '<a href="../" style="color:#f2e8d5">退出</a>';
    document.body.appendChild(bar);
    document.body.style.paddingTop = '34px';
    elStatus = bar.querySelector('#np-status'); elPlayers = bar.querySelector('#np-players');
    bar.querySelector('#np-resign').onclick = function(){ if (confirm('确认认输？')) socket.emit('resign'); };

    var chat = document.createElement('div');
    chat.style.cssText = 'position:fixed;right:12px;bottom:12px;width:260px;height:300px;z-index:99999;background:#ece3d0;border:1px solid #cabd9f;border-radius:8px;display:none;flex-direction:column;box-shadow:0 6px 20px rgba(0,0,0,.25);font:13px "Songti SC",serif';
    chat.innerHTML = '<div style="padding:6px 10px;border-bottom:1px solid #cabd9f;color:#201d16;font-weight:bold">桌内聊天</div>'
      + '<div id="np-log" style="flex:1;overflow-y:auto;padding:8px 10px;color:#443c30"></div>'
      + '<div style="display:flex;border-top:1px solid #cabd9f"><input id="np-in" maxlength="200" placeholder="说点什么…" style="flex:1;border:0;background:transparent;padding:8px;font:13px \'Songti SC\',serif;outline:none"><button id="np-send" style="border:0;background:#9d2c21;color:#f2e8d5;padding:0 12px;cursor:pointer">发</button></div>';
    document.body.appendChild(chat);
    elChatLog = chat.querySelector('#np-log'); elChatIn = chat.querySelector('#np-in');
    bar.querySelector('#np-chat-t').onclick = function(){ chat.style.display = chat.style.display==='flex'?'none':'flex'; if(elChatIn) elChatIn.focus(); };
    function send(){ var v=elChatIn.value.trim(); if(v){ socket.emit('chat',{text:v}); elChatIn.value=''; } }
    chat.querySelector('#np-send').onclick = send;
    elChatIn.addEventListener('keydown', function(e){ if(e.key==='Enter') send(); });
  }
  function setStatus(t){ if (elStatus) elStatus.textContent = t; }
  function setPlayers(p){ if (elPlayers) elPlayers.textContent = '红：'+(p.red||'空')+'　黑：'+(p.black||'空')+(p.spectators?('　观'+p.spectators):''); }
  function addChat(m){ if(!elChatLog)return; var who=m.seat==='red'?'红方':(m.seat==='black'?'黑方':'观众');
    var d=document.createElement('div'); d.innerHTML='<b style="color:#9d2c21">'+esc(m.name)+'</b> <span style="color:#8a8069;font-size:11px">('+who+')</span>：'+esc(m.text);
    elChatLog.appendChild(d); elChatLog.scrollTop=elChatLog.scrollHeight; }
  function banner(t){ var d=document.createElement('div'); d.style.cssText='position:fixed;left:0;right:0;top:0;z-index:99999;background:#9d2c21;color:#fff;padding:8px;text-align:center;font:14px serif'; d.textContent=t; document.body.appendChild(d); }
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
})();
