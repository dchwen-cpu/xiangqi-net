/* 立山象棋 · 联网层
 * 加到象棋 app 的 index.html 末尾：<script src="netplay.js"></script>
 * 仅当 URL 带 ?table=... 时激活；否则 app 照常离线运行，行为不变。
 * 原理：把“网络对战”做成人机模式的变体——对手那一方交给网络而非引擎。
 *   本地经 makeMove 走子 → 广播；收到对方着法 → 喂给 makeMove；网络模式下引擎永不出手。
 */
(function(){
  var params = new URLSearchParams(location.search);
  var tableId = params.get('table');
  if (!tableId) return;                          // 非联网模式，直接返回
  var seatWanted = params.get('seat') || 'auto';
  var myName = params.get('name') || '访客';

  var myColor = null, isSpectator = false, applyingRemote = false;
  window.__netMode = false;

  // 载入 socket.io 客户端（与服务器同源）
  var s = document.createElement('script');
  s.src = '/socket.io/socket.io.js';
  s.onload = init;
  s.onerror = function(){ banner('无法加载对战组件，请确认已连到象棋室服务器'); };
  document.head.appendChild(s);

  function init(){
    var socket = io();
    window.__netSocket = socket;
    buildUI(socket);

    socket.on('connect', function(){
      socket.emit('table:join', { tableId: tableId, seat: seatWanted, name: myName });
    });
    socket.on('table:state', function(st){ setup(st, socket); });
    socket.on('move', function(m){ if (m && typeof m.fr === 'number') applyRemote(m); });
    socket.on('chat', function(msg){ addChat(msg); });
    socket.on('table:players', function(p){ setPlayers(p); });
    socket.on('table:over', function(o){ setStatus((o.reason||'') + '，对局结束'); });
    socket.on('disconnect', function(){ setStatus('与服务器断开，重连中…'); });
  }

  // —— 进入网络模式 ——
  function setup(st, socket){
    var seat = st.seat;
    isSpectator = (seat === 'spectate');
    myColor = seat === 'red' ? 'r' : (seat === 'black' ? 'b' : null);

    skipIntro();                                  // 尽力跳过开场/选择模式的遮罩，直接进棋盘

    try { if (typeof reset === 'function') reset(); } catch(e){}

    // 借用人机模式：对手方 = 网络控制
    window.__netMode = true;
    try {
      mode = 'ai';
      if (!isSpectator) aiSide = (myColor === 'r') ? 'b' : 'r';
      else aiSide = 'x';                          // 观战：双方都不由本地走
    } catch(e){}

    // 引擎在网络模式下永不出手
    if (typeof triggerAI === 'function' && !triggerAI.__net){
      var _t = triggerAI;
      window.triggerAI = function(){ if (window.__netMode) return; return _t.apply(this, arguments); };
      window.triggerAI.__net = true;
    }
    // 包住 makeMove：本地走子→广播；远端(applyingRemote)→不广播；观战者禁止本地走子
    if (typeof makeMove === 'function' && !makeMove.__net){
      var _m = makeMove;
      window.makeMove = function(fr,fc,tr,tc){
        if (window.__netMode && isSpectator && !applyingRemote) return;      // 观战禁走
        var r = _m(fr,fc,tr,tc);
        if (window.__netMode && !applyingRemote){
          socket.emit('move', { fr:fr, fc:fc, tr:tr, tc:tc });
        }
        return r;
      };
      window.makeMove.__net = true;
    }

    // 回放历史着法追到当前局面
    applyingRemote = true;
    try { (st.moves||[]).forEach(function(m){ makeMove(m.fr,m.fc,m.tr,m.tc); }); } catch(e){}
    applyingRemote = false;
    try { turn = st.turn || 'r'; if (typeof draw === 'function') draw(); } catch(e){}

    setPlayers(st.seats || {});
    setStatus(isSpectator ? '观战中' : (myColor==='r' ? '你执红（先手）' : '你执黑（后手）'));
  }

  function applyRemote(m){
    applyingRemote = true;
    try { makeMove(m.fr,m.fc,m.tr,m.tc); } catch(e){}
    applyingRemote = false;
    try { if (typeof draw === 'function') draw(); } catch(e){}
  }

  // 尽力关掉开场遮罩：点掉“进入/开始”一类按钮，隐藏明显的全屏浮层
  function skipIntro(){
    try {
      var btns = document.querySelectorAll('button, a, .btn');
      btns.forEach(function(b){
        var tx = (b.textContent||'').trim();
        if (/^进\s*入$|开始$|开\s*局|进入棋盘/.test(tx)) { try{ b.click(); }catch(e){} }
      });
    } catch(e){}
  }

  // —— 注入 UI：顶部状态条 + 右下聊天 ——
  var elStatus, elPlayers, elChatLog, elChatIn;
  function buildUI(socket){
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:99999;background:#9d2c21;color:#f2e8d5;font:13px/1.6 "Songti SC",serif;padding:5px 12px;display:flex;gap:14px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    bar.innerHTML = '<b style="letter-spacing:.1em">立山象棋室</b>'
      + '<span id="np-players">—</span>'
      + '<span id="np-status" style="flex:1">连接中…</span>'
      + '<button id="np-resign" style="background:transparent;border:1px solid #f2e8d5;color:#f2e8d5;border-radius:4px;padding:2px 8px;cursor:pointer">认输</button>'
      + '<button id="np-chat-t" style="background:transparent;border:1px solid #f2e8d5;color:#f2e8d5;border-radius:4px;padding:2px 8px;cursor:pointer">聊天</button>'
      + '<a href="../" style="color:#f2e8d5">退出</a>';
    document.body.appendChild(bar);
    document.body.style.paddingTop = '34px';
    elStatus = bar.querySelector('#np-status');
    elPlayers = bar.querySelector('#np-players');
    bar.querySelector('#np-resign').onclick = function(){ if (confirm('确认认输？')) socket.emit('resign'); };

    var chat = document.createElement('div');
    chat.id = 'np-chat';
    chat.style.cssText = 'position:fixed;right:12px;bottom:12px;width:260px;height:300px;z-index:99999;background:#ece3d0;border:1px solid #cabd9f;border-radius:8px;display:none;flex-direction:column;box-shadow:0 6px 20px rgba(0,0,0,.25);font:13px "Songti SC",serif';
    chat.innerHTML = '<div style="padding:6px 10px;border-bottom:1px solid #cabd9f;color:#201d16;font-weight:bold">桌内聊天</div>'
      + '<div id="np-log" style="flex:1;overflow-y:auto;padding:8px 10px;color:#443c30"></div>'
      + '<div style="display:flex;border-top:1px solid #cabd9f"><input id="np-in" maxlength="200" placeholder="说点什么…" style="flex:1;border:0;background:transparent;padding:8px;font:13px \'Songti SC\',serif;outline:none"><button id="np-send" style="border:0;background:#9d2c21;color:#f2e8d5;padding:0 12px;cursor:pointer">发</button></div>';
    document.body.appendChild(chat);
    elChatLog = chat.querySelector('#np-log');
    elChatIn = chat.querySelector('#np-in');
    bar.querySelector('#np-chat-t').onclick = function(){ chat.style.display = chat.style.display==='flex'?'none':'flex'; elChatIn.focus(); };
    function send(){ var v = elChatIn.value.trim(); if (v){ socket.emit('chat', { text:v }); elChatIn.value=''; } }
    chat.querySelector('#np-send').onclick = send;
    elChatIn.addEventListener('keydown', function(e){ if (e.key==='Enter') send(); });
  }
  function setStatus(t){ if (elStatus) elStatus.textContent = t; }
  function setPlayers(p){ if (elPlayers) elPlayers.textContent = '红：' + (p.red||'空') + '　黑：' + (p.black||'空') + (p.spectators?('　观'+p.spectators):''); }
  function addChat(m){
    if (!elChatLog) return;
    var who = m.seat==='red'?'红方':(m.seat==='black'?'黑方':'观众');
    var d = document.createElement('div');
    d.innerHTML = '<b style="color:#9d2c21">'+esc(m.name)+'</b> <span style="color:#8a8069;font-size:11px">('+who+')</span>：'+esc(m.text);
    elChatLog.appendChild(d); elChatLog.scrollTop = elChatLog.scrollHeight;
  }
  function banner(t){ var d=document.createElement('div'); d.style.cssText='position:fixed;left:0;right:0;top:0;z-index:99999;background:#9d2c21;color:#fff;padding:8px;text-align:center;font:14px serif'; d.textContent=t; document.body.appendChild(d); }
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
})();
