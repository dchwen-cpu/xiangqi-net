/* 象棋室 · 联网层 v7
 * 加到 index.html 末尾：<script src="netplay.js"></script>
 * 仅当 URL 带 ?table=... 时激活；否则离线版行为完全不变。
 */
(function(){
  var params  = new URLSearchParams(location.search);
  var tableId = params.get('table');
  var hasAiParam = !!params.get('aiLevel');
  if(tableId || hasAiParam){
    try{
      var _st=document.createElement('style');
      _st.textContent='#intro-screen{display:none!important;opacity:0!important;visibility:hidden!important}';
      (document.head||document.documentElement).appendChild(_st);
    }catch(e){}
  }
  if (!tableId) return;

  // 立刻注入：从棋室进来时跳过棋盘程序自带的开场页（越早越好，避免闪现）
  (function(){
    try{
      var st=document.createElement('style');
      st.id='np-hide-intro';
      st.textContent='#intro-screen{display:none!important;opacity:0!important;visibility:hidden!important}';
      (document.head||document.documentElement).appendChild(st);
    }catch(e){}
  })();

  var seatWanted = decodeURIComponent(params.get('seat')   || 'auto');
  var myName     = decodeURIComponent(params.get('name')   || '访客');
  var optPerMove = parseInt(params.get('perMove')) || 0;   // 每步时限（秒）
  var optTotal   = parseInt(params.get('total'))   || 0;   // 全局时间（秒/方）
  var optHandicap= decodeURIComponent(params.get('handicap') || '');  // 让子

  // 每标签独立 PID
  var PID = sessionStorage.getItem('lsz_pid');
  if (!PID){ PID='p'+Math.random().toString(36).slice(2)+Date.now().toString(36); sessionStorage.setItem('lsz_pid',PID); }

  var myColor=null, isSpectator=false;
  var aiSeat=null, aiLv=6, aiDriving=false;   // AI 坐哪方、棋力、是否由我驱动
  var applyingRemote=false, appliedCount=0;
  var uiBuilt=false, hooksSet=false, endReported=false;
  window.__netMode = false;

  // ═══ 观战人机对局（?watch=<id>）═══
  // 接收对局者推来的棋盘快照并渲染，只看不动。
  var watchId = params.get('watch');
  if(watchId){
    function setupWatch(){
      try{
        var scr=document.getElementById('intro-screen');
        if(scr) scr.style.display='none';
      }catch(e){}
      buildWatchUI(watchId);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',setupWatch);
    else setTimeout(setupWatch, 250);
    return;   // 不启动联网对局层，也不启动单机层
  }

  function buildWatchUI(id){
    // 观战时禁掉一切会改动棋盘的原生控件，纯只读
    var st=document.createElement('style');
    st.textContent=[
      'h1,#status{display:none!important}',
      '#trig-mode,#mtrig-mode,#trig-level,#trig-redlevel,#trig-blacklevel,',
      '#mtrig-level,#restart,#draw-btn,#undo,#mm-btn,#hint-btn,',
      '#endgame-btn,#assess-btn{display:none!important}',
      'body{padding-top:34px!important}',
      '#solo-bar{position:fixed;top:0;left:0;right:0;height:34px;z-index:2147483647;',
        'display:flex;align-items:center;gap:8px;padding:0 10px;overflow:hidden;',
        'background:#4a7c59;color:#f2e8d5;font:12px "Songti SC","SimSun",serif}',
      '#solo-bar b{font-family:"Kaiti SC","楷体",serif;font-size:.88rem;letter-spacing:.08em}',
      '#solo-bar .sp{flex:1}',
      '#solo-bar a,#solo-bar button{color:#f2e8d5;text-decoration:none;font-size:11.5px;',
        'background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.34);',
        'border-radius:4px;padding:3px 10px;cursor:pointer;font-family:"Songti SC",serif}',
      '#solo-chat{position:fixed;right:10px;bottom:10px;width:250px;height:290px;',
        'z-index:2147483647;background:#e4dabf;border:1px solid #cabd9f;border-radius:8px;',
        'display:none;flex-direction:column;box-shadow:0 6px 20px rgba(0,0,0,.25);',
        'font:13px "Songti SC","SimSun",serif}',
      '#solo-chat.open{display:flex}',
      '#solo-chat-hd{padding:6px 11px;border-bottom:1px solid #cabd9f;color:#201d16;',
        'font-family:"Kaiti SC","楷体",serif;font-size:.9rem;display:flex;align-items:center}',
      '#solo-chat-hd .x{margin-left:auto;cursor:pointer;color:#8a8069;font-size:15px;line-height:1}',
      '#solo-log{flex:1;overflow-y:auto;padding:8px 11px;color:#443c30;line-height:1.7;min-height:0}',
      '#solo-log .who{font-weight:bold;color:#9d2c21}',
      '#solo-in{display:flex;border-top:1px solid #cabd9f;padding:6px;gap:5px}',
      '#solo-in input{flex:1;border:1px solid #cabd9f;border-radius:4px;padding:5px 8px;',
        'background:#ece3d0;color:#201d16;outline:none;font:13px "Songti SC",serif}',
      '#solo-in button{background:#9d2c21;color:#f2e8d5;border:0;border-radius:4px;',
        'padding:5px 11px;cursor:pointer;font:13px "Songti SC",serif}',
      '#solo-unread{background:#fff;color:#9d2c21;border-radius:8px;padding:0 5px;',
        'font-size:10.5px;margin-left:4px;display:none}',
      '@media(max-width:580px){#solo-chat{left:10px;right:10px;width:auto;height:52vh}}'
    ].join('');
    document.head.appendChild(st);

    var bar=document.createElement('div'); bar.id='solo-bar';
    bar.innerHTML='<b>观战中</b><span id="watch-info" style="opacity:.9">连接中…</span>'
      +'<div class="sp"></div>'
      +'<button id="solo-chat-btn">聊天<span id="solo-unread"></span></button>'
      +'<a href="../">← 返回大厅</a>';
    document.body.appendChild(bar);

    var box=document.createElement('div'); box.id='solo-chat';
    box.innerHTML='<div id="solo-chat-hd">厅内闲聊<span class="x" id="solo-chat-x">×</span></div>'
      +'<div id="solo-log"></div>'
      +'<div id="solo-in"><input id="solo-msg" maxlength="150" placeholder="说点什么…" autocomplete="off">'
      +'<button id="solo-send">发</button></div>';
    document.body.appendChild(box);

    // 观战只读：任何走子一律拦下
    try{
      if(typeof makeMove==='function' && !makeMove.__watch){
        window.makeMove=function(){ return; };
        window.makeMove.__watch=true;
      }
      if(typeof triggerAI==='function' && !triggerAI.__watch){
        window.triggerAI=function(){ return; };
        window.triggerAI.__watch=true;
      }
    }catch(e){}

    var sc3=document.createElement('script'); sc3.src='/socket.io/socket.io.js';
    sc3.onload=function(){
      var sock=io(); var unread=0;
      var myName=decodeURIComponent(params.get('name')||'')
        || (localStorage.getItem('lsz_name')||'').trim() || '访客';
      sock.on('connect', function(){
        sock.emit('lobby:enter',{name:myName});
        sock.emit('solo:watch',{id:id}, function(res){
          var el=document.getElementById('watch-info');
          if(res&&res.ok){ if(el) el.textContent=esc(res.name)+' vs 电脑 '+res.level+'级'; }
          else { if(el) el.textContent=(res&&res.err)||'该对局已结束'; }
        });
      });
      sock.on('solo:state', function(snap){ applyWatchSnapshot(snap); });
      sock.on('solo:over', function(){
        var el=document.getElementById('watch-info');
        if(el) el.textContent='对局已结束';
      });
      sock.on('lobby:chat', function(m){
        var log=document.getElementById('solo-log'); if(!log) return;
        var d=document.createElement('div');
        d.innerHTML='<span class="who">'+esc(m.name)+'</span>：'+esc(m.text);
        log.appendChild(d); log.scrollTop=log.scrollHeight;
        while(log.children.length>60) log.removeChild(log.firstChild);
        if(!box.classList.contains('open')){
          unread++;
          var u=document.getElementById('solo-unread');
          if(u){ u.textContent=unread; u.style.display='inline-block'; }
        }
      });
      function send(){
        var i=document.getElementById('solo-msg'); var v=(i.value||'').trim();
        if(v){ sock.emit('lobby:chat',{text:v,name:myName}); i.value=''; }
      }
      document.getElementById('solo-send').onclick=send;
      document.getElementById('solo-msg').addEventListener('keydown',function(e){
        if(e.key==='Enter') send();
      });
      document.getElementById('solo-chat-btn').onclick=function(){
        box.classList.toggle('open');
        if(box.classList.contains('open')){
          unread=0;
          var u=document.getElementById('solo-unread'); if(u) u.style.display='none';
          var log=document.getElementById('solo-log'); if(log) log.scrollTop=log.scrollHeight;
        }
      };
      document.getElementById('solo-chat-x').onclick=function(){ box.classList.remove('open'); };
    };
    document.head.appendChild(sc3);

    setTimeout(function(){
      try{ if(typeof sizeCanvas==='function') sizeCanvas(true); if(typeof draw==='function') draw(); }catch(e){}
    }, 120);
    window.addEventListener('resize', function(){
      try{ if(typeof sizeCanvas==='function') sizeCanvas(true); }catch(e){}
    });
  }

  // 把收到的快照还原到棋盘上并重绘
  function applyWatchSnapshot(snap){
    if(!snap || !snap.b) return;
    try{
      var flat=snap.b.split(',');
      var i=0;
      for(var r=0;r<ROWS;r++){
        for(var c=0;c<COLS;c++){
          var v=flat[i++];
          board[r][c] = v ? { side:v.charAt(0), type:v.slice(1) } : null;
        }
      }
      turn = snap.t || 'r';
      if(typeof draw==='function') draw();
      var el=document.getElementById('watch-info');
      if(el && snap.st) el.textContent = el.textContent.split('　')[0] + '　' + snap.st;
    }catch(e){}
  }

  // ═══ 纯单机模式（?aiLevel=N，无 table）═══
  // 与电脑下棋不经服务器托管：棋局完全在本地跑，所有原生功能（选边、先走方、
  // 残局、测评、重开、悔棋…）一律可用，不会再和服务器分配的座位/回合打架。
  // 只保留一条细顶栏用来回大厅，外加大厅公共聊天。
  var aiLevelParam = parseInt(params.get('aiLevel'))||0;
  if(aiLevelParam && !tableId){
    function setupSoloMode(){
      // 设好初始棋力（进来后仍可在棋盘里自由改）
      try{
        aiLevel = aiLevelParam;
        if(typeof redAiLevel!=='undefined') redAiLevel=aiLevelParam;
        if(typeof refreshTriggerLabels==='function') refreshTriggerLabels();
        if(typeof prepEngineForLevel==='function') prepEngineForLevel(aiLevelParam);
      }catch(e){}
      buildSoloBar();
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',setupSoloMode);
    else setTimeout(setupSoloMode, 300);
    return;   // 不启动联网对局层
  }

  // 把当前棋盘拍成快照。用轮询而不是挂钩走子函数——
  // 这样悔棋、重开、换边、进出残局等所有变化都能捕捉到，
  // 而且完全不碰棋盘的任何原生逻辑，零干扰。
  function snapshotBoard(){
    try{
      if(typeof board==='undefined' || !board) return null;
      var flat=[];
      for(var r=0;r<board.length;r++){
        for(var c=0;c<board[r].length;c++){
          var p=board[r][c];
          flat.push(p ? (p.side+p.type) : '');
        }
      }
      return {
        b: flat.join(','),
        t: (typeof turn!=='undefined') ? turn : 'r',
        lv: (typeof aiLevel!=='undefined') ? aiLevel : 6,
        st: (function(){ try{ var e=document.getElementById('status');
             return e ? (e.textContent||'').slice(0,40) : ''; }catch(e){ return ''; } })()
      };
    }catch(e){ return null; }
  }
  function startBroadcast(sock){
    var last='';
    setInterval(function(){
      var snap=snapshotBoard();
      if(!snap) return;
      var sig=snap.b+'|'+snap.t+'|'+snap.st;
      if(sig===last) return;          // 没变化就不推，省流量
      last=sig;
      try{ sock.emit('solo:push', snap); }catch(e){}
    }, 700);
  }

  // 单机模式的细顶栏：返回大厅 + 厅内聊天（不干扰棋盘任何原生功能）
  function buildSoloBar(){
    var st=document.createElement('style');
    st.textContent=[
      'body{padding-top:34px!important}',
      '#solo-bar{position:fixed;top:0;left:0;right:0;height:34px;z-index:2147483647;',
        'display:flex;align-items:center;gap:8px;padding:0 10px;overflow:hidden;',
        'background:#9d2c21;color:#f2e8d5;font:12px "Songti SC","SimSun",serif}',
      '#solo-bar b{font-family:"Kaiti SC","楷体",serif;font-size:.88rem;letter-spacing:.08em}',
      '#solo-bar .sp{flex:1}',
      '#solo-bar a,#solo-bar button{color:#f2e8d5;text-decoration:none;font-size:11.5px;',
        'background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.32);',
        'border-radius:4px;padding:3px 10px;cursor:pointer;',
        'font-family:"Songti SC","SimSun",serif}',
      '#solo-bar a:hover,#solo-bar button:hover{background:rgba(255,255,255,.26)}',
      '#solo-chat{position:fixed;right:10px;bottom:10px;width:250px;height:290px;',
        'z-index:2147483647;background:#e4dabf;border:1px solid #cabd9f;border-radius:8px;',
        'display:none;flex-direction:column;box-shadow:0 6px 20px rgba(0,0,0,.25);',
        'font:13px "Songti SC","SimSun",serif}',
      '#solo-chat.open{display:flex}',
      '#solo-chat-hd{padding:6px 11px;border-bottom:1px solid #cabd9f;color:#201d16;',
        'font-family:"Kaiti SC","楷体",serif;font-size:.9rem;display:flex;align-items:center}',
      '#solo-chat-hd .x{margin-left:auto;cursor:pointer;color:#8a8069;font-size:15px;line-height:1}',
      '#solo-log{flex:1;overflow-y:auto;padding:8px 11px;color:#443c30;line-height:1.7;min-height:0}',
      '#solo-log .who{font-weight:bold;color:#9d2c21}',
      '#solo-in{display:flex;border-top:1px solid #cabd9f;padding:6px;gap:5px}',
      '#solo-in input{flex:1;border:1px solid #cabd9f;border-radius:4px;padding:5px 8px;',
        'background:#ece3d0;color:#201d16;outline:none;font:13px "Songti SC",serif}',
      '#solo-in button{background:#9d2c21;color:#f2e8d5;border:0;border-radius:4px;',
        'padding:5px 11px;cursor:pointer;font:13px "Songti SC",serif}',
      '#solo-unread{background:#fff;color:#9d2c21;border-radius:8px;padding:0 5px;',
        'font-size:10.5px;margin-left:4px;display:none}',
      '@media(max-width:580px){#solo-chat{left:10px;right:10px;width:auto;height:52vh}}'
    ].join('');
    document.head.appendChild(st);

    var bar=document.createElement('div'); bar.id='solo-bar';
    bar.innerHTML='<b>象棋室</b>'
      +'<span style="opacity:.85">与电脑对弈</span>'
      +'<span id="solo-watchers" style="opacity:.8;font-size:11px"></span>'
      +'<div class="sp"></div>'
      +'<button id="solo-chat-btn">聊天<span id="solo-unread"></span></button>'
      +'<a href="../">← 返回大厅</a>';
    document.body.appendChild(bar);

    var box=document.createElement('div'); box.id='solo-chat';
    box.innerHTML='<div id="solo-chat-hd">厅内闲聊<span class="x" id="solo-chat-x">×</span></div>'
      +'<div id="solo-log"></div>'
      +'<div id="solo-in"><input id="solo-msg" maxlength="150" placeholder="说点什么…" autocomplete="off">'
      +'<button id="solo-send">发</button></div>';
    document.body.appendChild(box);

    // 连 socket：一为大厅聊天，二为把棋盘快照转播给旁观的朋友。
    // 注意棋局本身完全在本地跑，服务器只是转播台，不参与任何裁决。
    var sc2=document.createElement('script'); sc2.src='/socket.io/socket.io.js';
    sc2.onload=function(){
      var sock=io(); var unread=0;
      var myName=decodeURIComponent(params.get('name')||'')
        || (localStorage.getItem('lsz_name')||'').trim() || '访客';
      sock.on('connect', function(){
        sock.emit('lobby:enter',{name:myName});
        sock.emit('solo:begin',{name:myName, level:aiLevelParam}, function(res){
          if(res&&res.ok) startBroadcast(sock);
        });
      });
      window.addEventListener('beforeunload', function(){
        try{ sock.emit('solo:end'); }catch(e){}
      });
      sock.on('lobby:chat', function(m){
        var log=document.getElementById('solo-log'); if(!log) return;
        var d=document.createElement('div');
        d.innerHTML='<span class="who">'+esc(m.name)+'</span>：'+esc(m.text);
        log.appendChild(d); log.scrollTop=log.scrollHeight;
        while(log.children.length>60) log.removeChild(log.firstChild);
        if(!box.classList.contains('open')){
          unread++;
          var u=document.getElementById('solo-unread');
          if(u){ u.textContent=unread; u.style.display='inline-block'; }
        }
      });
      function send(){
        var i=document.getElementById('solo-msg'); var v=(i.value||'').trim();
        if(v){ sock.emit('lobby:chat',{text:v,name:myName}); i.value=''; }
      }
      document.getElementById('solo-send').onclick=send;
      document.getElementById('solo-msg').addEventListener('keydown',function(e){
        if(e.key==='Enter') send();
      });
      document.getElementById('solo-chat-btn').onclick=function(){
        box.classList.toggle('open');
        if(box.classList.contains('open')){
          unread=0;
          var u=document.getElementById('solo-unread'); if(u) u.style.display='none';
          var log=document.getElementById('solo-log'); if(log) log.scrollTop=log.scrollHeight;
        }
      };
      document.getElementById('solo-chat-x').onclick=function(){ box.classList.remove('open'); };
    };
    document.head.appendChild(sc2);

    // 顶栏占了 34px，让棋盘按新的可用高度重算
    setTimeout(function(){
      try{ if(typeof sizeCanvas==='function') sizeCanvas(true); if(typeof draw==='function') draw(); }catch(e){}
    }, 120);
    window.addEventListener('resize', function(){
      try{ if(typeof sizeCanvas==='function') sizeCanvas(true); }catch(e){}
    });
  }

  var sc=document.createElement('script'); sc.src='/socket.io/socket.io.js';
  sc.onload=init;
  sc.onerror=function(){ showBanner('无法连接象棋室服务器'); };
  document.head.appendChild(sc);

  // ── 计时器状态 ────────────────────────────────────────────────
  var timer = {
    red:  { rem: optTotal||optPerMove||0 },
    black:{ rem: optTotal||optPerMove||0 },
    active: null, iv: null
  };
  var elTimerR, elTimerB;

  function fmtTime(s){
    if(s<=0) return '00:00';
    var m=Math.floor(s/60), sec=s%60;
    return (m<10?'0':'')+m+':'+(sec<10?'0':'')+sec;
  }
  function updateTimerDisplay(){
    if(elTimerR) elTimerR.textContent = (optTotal||optPerMove) ? fmtTime(timer.red.rem) : '';
    if(elTimerB) elTimerB.textContent = (optTotal||optPerMove) ? fmtTime(timer.black.rem) : '';
    if(elTimerR) elTimerR.style.fontWeight = timer.active==='red'   ? 'bold' : 'normal';
    if(elTimerB) elTimerB.style.fontWeight = timer.active==='black' ? 'bold' : 'normal';
    if(elTimerR) elTimerR.style.color = timer.red.rem<=10   ? '#9d2c21' : '#443c30';
    if(elTimerB) elTimerB.style.color = timer.black.rem<=10 ? '#201d16' : '#443c30';
  }
  function startTimer(side, socket){
    if(!optTotal && !optPerMove) return;
    clearInterval(timer.iv);
    timer.active = side;
    timer.iv = setInterval(function(){
      timer[side].rem--;
      updateTimerDisplay();
      if(timer[side].rem<=0){
        clearInterval(timer.iv);
        if(!isSpectator) socket.emit('timeout');
        setStatus((side==='red'?'红方':'黑方')+'超时负', true);
      }
    },1000);
  }
  function stopTimer(){
    clearInterval(timer.iv);
    timer.iv=null; timer.active=null;
  }
  function onMoveMade(side, socket){
    // 切换计时到对方
    if(optPerMove){
      var opp=(side==='red')?'black':'red';
      timer[opp].rem = optPerMove;
    }
    startTimer(side==='red'?'black':'red', socket);
  }

  // ── 让子：局面初始化后移除棋子 ───────────────────────────────
  // hc: 让子类型字符串，来自服务器广播的实时值，不再依赖页面加载时冻结的 URL 参数
  function applyHandicap(hc){
    if(!hc||hc==='none') return;
    try{
      var removed=0;
      for(var r=ROWS-1;r>=0;r--){
        for(var c=COLS-1;c>=0;c--){
          var p=board[r][c];
          if(!p||p.side!=='r') continue;
          if(hc==='horse1'     && p.type==='M' && removed<1){ board[r][c]=null; removed++; }
          if(hc==='horse2'     && p.type==='M')               { board[r][c]=null; }
          if(hc==='cannon1'    && p.type==='P' && removed<1){ board[r][c]=null; removed++; }
          if(hc==='rook1'      && p.type==='C' && removed<1){ board[r][c]=null; removed++; }
          if(hc==='rook_horse' &&(p.type==='C'||p.type==='M')&&removed<2){ board[r][c]=null; removed++; }
        }
      }
      if(typeof draw==='function') draw();
    }catch(e){}
  }

  // ── 主流程 ────────────────────────────────────────────────────
  function init(){
    var socket=io();
    window.__netSocket=socket;

    socket.on('connect', function(){
      socket.emit('table:join',{tableId:tableId,seat:seatWanted,name:myName,playerId:PID});
    });
    socket.on('table:state', function(st){
      myColor     = st.seat==='red'?'r':(st.seat==='black'?'b':null);
      isSpectator = (st.seat==='spectate');
      aiSeat      = st.aiSeat||null;
      aiLv        = st.aiLevel||6;
      // 我是在座玩家且对面是AI → 由我的浏览器驱动AI计算
      aiDriving   = !!(aiSeat && myColor && ((myColor==='r'&&aiSeat==='black')||(myColor==='b'&&aiSeat==='red')));
      if(!uiBuilt){
        skipIntro(function(){
          buildNetUI(socket);
          uiBuilt=true;
          // 新顶栏搭好、body padding 生效后，强制棋盘按最新可用空间重算一次
          try{ if(typeof sizeCanvas==='function') sizeCanvas(true); }catch(e){}
          // 保险：窗口尺寸变化（含手机横竖屏切换）时，我们自己的顶栏结构
          // 不会变，但仍主动补一次强制重算+重绘，避免任何边缘情况下棋盘没跟着调整
          if(!window.__netResizeBound){
            window.__netResizeBound = true;
            var _rTimer=null;
            function _onResize(){
              clearTimeout(_rTimer);
              _rTimer=setTimeout(function(){
                try{ if(typeof sizeCanvas==='function') sizeCanvas(true); if(typeof draw==='function') draw(); }catch(e){}
              }, 150);
            }
            window.addEventListener('resize', _onResize);
            window.addEventListener('orientationchange', _onResize);
          }
          setupHooks(socket);
          doSync(st, socket);
          // 如有历史着法，从第一步开始计时
          if((optTotal||optPerMove)&&st.moves&&st.moves.length>0){
            var lastSide = st.moves.length%2===0 ? 'red' : 'black';
            startTimer(lastSide, socket);
          }
        });
      } else {
        doSync(st, socket);
      }
    });
    // 对局设置变化（含让子）：更新面板显示；若还没人走子，立刻让双方棋盘反映新设置
    socket.on('table:options', function(d){
      applyOptsToPanel(d.options);
      if(appliedCount===0 && !isSpectator){
        try{ if(typeof reset==='function') reset(); }catch(e){}
        try{
          if(myColor==='b' && typeof boardFlipped!=='undefined' && !boardFlipped) boardFlipped=true;
        }catch(e){}
        if(d.options && d.options.handicap) applyHandicap(d.options.handicap);
        else if(typeof draw==='function') draw();
      }
    });
    socket.on('move', function(m){
      if(!m||typeof m.idx!=='number') return;
      if     (m.idx===appliedCount){ applyRemote(m); appliedCount++; onMoveMade(m.by, socket); refreshTurn(); checkLocalGameOver(socket); setTimeout(function(){ maybeRunAI(); },400); }
      else if(m.idx < appliedCount){ /* 忽略 */ }
      else   { socket.emit('sync:request'); }
    });
    socket.on('chat',          function(m){ addChat(m); });
    socket.on('table:players', function(p){
      setPlayers(p);
      if(p.aiSeat!==undefined){
        aiSeat=p.aiSeat; aiLv=p.aiLevel||6;
        aiDriving = !!(aiSeat && myColor && ((myColor==='r'&&aiSeat==='black')||(myColor==='b'&&aiSeat==='red')));
        if(hooksSet){
          applyTableMode();
          refreshAiLvUI();
          warmUpEngine();                        // AI 一落座就开始加载引擎
          setTimeout(maybeRunAI,300);
        }
      }
    });
    socket.on('table:over',    function(o){
      endReported=true; stopTimer();
      setStatus(o.reason||'对局结束',true);
      showEndPanel(o.reason||'对局结束');
    });
    socket.on('disconnect',    function(){ setStatus('连接中断，重连中…'); });
    // 再来一局：清面板、重置棋盘（table:state 会随后同步）
    socket.on('game:restart', function(d){
      hideEndPanel();
      // 再来一局会红黑互换。这里只做能立刻做的重置；
      // myColor/aiDriving/棋盘翻转方向由紧随其后的 table:state（服务器 resyncAll 发出）
      // 统一按新座位重新计算，避免在这里用旧的 myColor 去推算而算错边。
      if(d){ aiSeat=d.aiSeat||null; aiLv=d.aiLevel||6; }
      try{ gameOver=false; }catch(e){}
      endReported=false;
      appliedCount=0;                            // 新局从零手开始计数
      stopTimer();
      if(d && d.options) curOptions=d.options;   // 让子随最新设置在重开局时一并生效
      if(optTotal){ timer.red.rem=optTotal; timer.black.rem=optTotal; }
      else if(optPerMove){ timer.red.rem=optPerMove; timer.black.rem=optPerMove; }
      updateTimerDisplay();
      addChat({name:'系统',seat:'',text:'新一局开始，红黑互换'});
    });

    // 悔棋：用页面内通知条代替 confirm()，避免浏览器拦截弹窗
    socket.on('undo:request', function(){ showUndoRequest(socket); });
    socket.on('undo:reject',  function(){ setStatus('对方拒绝了悔棋'); });
    socket.on('draw:request', function(){ showDrawRequest(socket); });
    socket.on('draw:reject',  function(){ setStatus('对方拒绝了和棋'); });
  }

  // ── 钩子（只设一次）──────────────────────────────────────────
  function setupHooks(socket){
    if(hooksSet) return; hooksSet=true;
    window.__netMode=true;
    applyTableMode();
    warmUpEngine();

    // triggerAI：人人对弈时禁用；我驱动AI时放行（回放中一律禁）
    if(typeof triggerAI==='function'&&!triggerAI.__net){
      var _t=triggerAI;
      window.triggerAI=function(){
        if(applyingRemote) return;                 // 回放历史着法时不许引擎插手
        if(isLocalSoloMode()) return _t.apply(this,arguments);   // 残局/测评：引擎照常工作
        if(window.__netMode && !aiDriving) return; // 纯人人对弈：引擎永不出手
        return _t.apply(this,arguments);
      };
      window.triggerAI.__net=true;
    }

    if(typeof makeMove==='function'&&!makeMove.__net){
      var _m=makeMove;
      window.makeMove=function(fr,fc,tr,tc){
        // 单机旁路：用户在与电脑对弈时进了残局闯关或棋力测评，
        // 那已是完全独立的单机局面，座位/回合跟联网对局无关——
        // 不能按联网规则拦截，也不该把这些着法发给服务器。
        if(isLocalSoloMode()){ return _m(fr,fc,tr,tc); }

        if(window.__netMode && isSpectator && !applyingRemote) return;
        if(window.__netMode && !applyingRemote){
          var t = (typeof turn!=='undefined') ? turn : null;
          var aiChar = aiSeat ? (aiSeat==='red'?'r':'b') : null;
          var iAmMover  = !!(myColor && t===myColor);
          var aiIsMover = !!(aiDriving && aiChar && t===aiChar);
          if(!iAmMover && !aiIsMover) return;      // 既不是我、也不是我驱动的AI → 拦下
        }
        var r=_m(fr,fc,tr,tc);
        if(window.__netMode && !applyingRemote){
          appliedCount++;
          socket.emit('move',{fr:fr,fc:fc,tr:tr,tc:tc});
          var moverChar = (typeof turn!=='undefined' && turn==='r') ? 'b' : 'r';  // 走完后 turn 已翻转
          onMoveMade(moverChar==='r'?'red':'black', socket);
          refreshTurn();
          checkLocalGameOver(socket);                    // 这一步是否已分胜负
          setTimeout(function(){ maybeRunAI(); },250);   // 我走完 → 看看该不该让AI应招
        }
        return r;
      };
      window.makeMove.__net=true;
    }
  }

  // 根据是否与电脑对弈，显示棋力下拉并同步当前级别
  function refreshAiLvUI(){
    var wrap=document.getElementById('nb-ailv-wrap');
    var sel=document.getElementById('nb-ailv');
    if(!wrap||!sel) return;
    var show=!!(aiSeat && aiDriving);
    wrap.style.display = show ? 'flex' : 'none';
    if(show) sel.value=String(aiLv);
  }

  // 预热强引擎：AI 落座后立即开始加载，避免轮到它时才现下
  function warmUpEngine(){
    if(!aiDriving || aiLv<4) return;
    try{
      if(typeof StrongEngine!=='undefined' && typeof StrongEngine.init==='function'
         && !StrongEngine.isReady() && !StrongEngine.isLoading()){
        StrongEngine.init('stockfish.js');
      }
      if(aiLv>=7 && typeof ensureNnueLoaded==='function') ensureNnueLoaded();
    }catch(e){}
  }

  // 是否处于"单机独立玩法"（残局闯关 / 棋力测评）——
  // 这两种玩法有自己的局面和规则，与联网对局无关，联网层应完全让路。
  function isLocalSoloMode(){
    try{
      if(typeof endgameMode !== 'undefined' && endgameMode) return true;
      if(typeof assessActive !== 'undefined' && assessActive) return true;
    }catch(e){}
    return false;
  }

  // 标记当前是"与电脑对弈"还是"真人对弈"，CSS 据此决定原生功能是否可用。
  // 与电脑下本质是单机，残局/测评/重开等全部放行；真人对弈才需要限制。
  function markGameKind(){
    try{
      var vsAI = !!aiSeat;
      document.body.classList.toggle('net-vs-ai', vsAI);
      document.body.classList.toggle('net-vs-human', !vsAI);
    }catch(e){}
  }

  // 根据本桌是否有AI，设置象棋 app 的对局模式
  function applyTableMode(){
    markGameKind();
    try{
      if(aiDriving && aiSeat){
        mode   = 'ai';
        aiSide = (aiSeat==='red') ? 'r' : 'b';   // 引擎执AI那一方
        aiLevel = aiLv;    // 裸赋值：app 的 aiLevel 是 let 声明的，不在 window 上
        if(typeof prepEngineForLevel==='function') prepEngineForLevel(aiLv);
      } else {
        mode   = 'pvp';
        aiSide = null;
      }
    }catch(e){}
  }

  // 轮到AI且由我驱动 → 让本地引擎算一步
  var aiWaitTries=0;
  function maybeRunAI(){
    if(!aiDriving || !aiSeat) return;
    if(typeof turn==='undefined') return;
    try{ if(gameOver) return; }catch(e){}
    var aiChar = aiSeat==='red' ? 'r' : 'b';
    if(turn!==aiChar) return;
    try{ if(aiThinking) return; }catch(e){}
    applyTableMode();

    // 4级以上需要强引擎：没就绪就等它，别让内置AI顶上（否则棋力名不副实）
    if(aiLv>=4 && typeof StrongEngine!=='undefined'){
      var ready=false;
      try{ ready=StrongEngine.isReady(); }catch(e){}
      if(!ready){
        try{
          if(typeof StrongEngine.init==='function' && !StrongEngine.isLoading()) StrongEngine.init('stockfish.js');
        }catch(e){}
        aiWaitTries++;
        if(aiWaitTries<40){                       // 最多等约 20 秒
          setStatus('强引擎加载中…（'+aiLv+'级）');
          setTimeout(maybeRunAI,500);
          return;
        }
        // 等太久：明确告知已降级，而不是默默用内置引擎
        addChat({name:'系统',seat:'',text:'强引擎加载失败，本局暂用内置引擎'});
      }
    }
    aiWaitTries=0;
    setStatus('电脑思考中…');
    try{ if(typeof triggerAI==='function') triggerAI(); }catch(e){}
  }

  // 检查强引擎文件是否存在（4级以上需要 stockfish.js，7级以上还需 .nnue）
  function checkEngineFiles(){
    try{
      fetch('stockfish.js',{method:'HEAD'}).then(function(r){
        if(!r.ok || (r.headers.get('content-type')||'').indexOf('html')>=0){
          engineMissing('stockfish.js');
        }
      }).catch(function(){ engineMissing('stockfish.js'); });
    }catch(e){}
  }
  function engineMissing(f){
    addChat({name:'系统',seat:'',text:'缺少引擎文件 '+f+'，4级以上棋力不可用（已降为内置引擎）'});
    setStatus('引擎文件缺失，仅内置AI可用', true);
  }

  // 本地判出胜负（将死/困毙/长将/重复等）→ 上报服务器，由服务器广播结束
  function checkLocalGameOver(socket){
    try{
      if(typeof gameOver==='undefined' || !gameOver) return;
      if(endReported) return;
      endReported=true;
      var reason='';
      try{
        var el=document.getElementById('status');
        reason=(el&&el.textContent)?el.textContent.trim():'';
      }catch(e){}
      stopTimer();
      socket.emit('table:gameover',{reason:reason});
      showEndPanel(reason||'对局结束');       // 本地先弹，不等服务器往返
    }catch(e){}
  }

  // ── 同步棋局 ─────────────────────────────────────────────────
  function doSync(st, socket){
    if(st.status!=='over') endReported=false;
    applyingRemote=true; appliedCount=0;
    try{ if(typeof reset==='function') reset(); }catch(e){}
    try{ (st.moves||[]).forEach(function(m){ makeMove(m.fr,m.fc,m.tr,m.tc); appliedCount++; }); }catch(e){}
    applyingRemote=false;
    try{ turn=st.turn||'r'; if(typeof draw==='function') draw(); }catch(e){}
    try{
      // 按当前执子方双向设定视角：执黑翻转、执红翻回。
      // 原来只有"黑→翻转"这一个方向，再来一局红黑互换后从黑变红时，
      // 棋盘会一直卡在翻转状态下不来。
      if(!isSpectator && myColor && typeof boardFlipped!=='undefined'){
        var want = (myColor==='b');
        if(boardFlipped!==want){ boardFlipped=want; if(typeof draw==='function') draw(); }
      }
    }catch(e){}
    // 应用让子
    if(st.options && st.options.handicap && st.moves && st.moves.length===0) applyHandicap(st.options.handicap);
    setPlayers(st.seats||{});
    refreshTurn();
    refreshAiLvUI();
    setTimeout(function(){ applyTableMode(); maybeRunAI(); },600);   // 开局若AI先手，让它先走
  }

  function applyRemote(m){
    applyingRemote=true;
    try{ makeMove(m.fr,m.fc,m.tr,m.tc); }catch(e){}
    applyingRemote=false;
    try{ if(typeof draw==='function') draw(); }catch(e){}
  }

  // 联网/AI 模式：直接隐藏开场页，不播过渡动画
  function skipIntro(onDone){
    // 尽早注入样式，避免开场页闪现
    try{
      var st=document.createElement('style');
      st.textContent='#intro-screen{display:none!important}';
      (document.head||document.documentElement).appendChild(st);
    }catch(e){}
    function doSkip(){
      try{
        var scr=document.getElementById('intro-screen');
        if(scr){ scr.classList.add('hide'); scr.style.display='none'; }
        // 开场页隐藏后棋盘才可见，需重算尺寸
        if(typeof sizeCanvas==='function'){ sizeCanvas(true); }
        if(typeof draw==='function') draw();
        // 让背景音乐按原逻辑进入对局音量
        var btn=document.getElementById('intro-enter-btn');
        if(btn && btn.__played!==true){ btn.__played=true; try{ btn.click(); }catch(e){} }
      }catch(e){}
      setTimeout(function(){ if(typeof onDone==='function') onDone(); },120);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',doSkip);
    else doSkip();
  }

  // ── 构建叠加 UI ──────────────────────────────────────────────
  var elStatus,elPlayers,elChatLog,elChatIn;

  function buildNetUI(socket){
    var st=document.createElement('style'); st.id='net-style';
    st.textContent=[
      // 隐藏原生标题与状态栏：我们有自己的一套。这两处此前从未被隐藏，
      // 是"棋盘挤出视口"的直接原因——sizeCanvas() 按原生 header 的固定留白预算
      // (桌面顶104/底40，手机顶44/底96)，我们的浮层叠加其上却完全不在预算内，
      // 顶+底一起超支就把棋盘挤出可视区域。
      'h1,#status{display:none!important}',
      // 走到这里必定是"真人对局"（与电脑下棋已改为纯单机，根本不进联网层）。
      // 真人对局的座位、回合、棋局都由服务器掌管，下列原生控件本地一改就会错位，
      // 因此一律锁定；顶栏已提供走服务器的对应版本（悔棋/求和/棋力/重开）。
      '#trig-mode,#mtrig-mode,#trig-level,#trig-redlevel,#trig-blacklevel,',
      '#mtrig-level,#restart,#draw-btn,#undo,#mm-btn,',
      '#endgame-btn,#assess-btn,#hint-btn{display:none!important}',
      // 只留一条紧凑顶栏，取消底栏——把腾出的空间都还给棋盘
      'body{padding-top:40px!important;padding-bottom:0!important}',
      '#net-top{position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483647;',
        'display:flex;align-items:center;gap:7px;padding:0 10px;overflow:hidden;',
        'background:#9d2c21;color:#f2e8d5;font:12.5px "Songti SC","SimSun",serif}',
      '#net-top b{font-family:"Kaiti SC","STKaiti","楷体",serif;font-size:.92rem;letter-spacing:.08em;flex-shrink:0}',
      '#net-exit{color:#f2e8d5;text-decoration:none;font-size:11px;opacity:.8;',
        'padding:2px 7px;border:1px solid rgba(255,255,255,.3);border-radius:4px;flex-shrink:0}',
      '#net-exit:hover{opacity:1}',
      // 菜单按钮组：横排在"象棋室/退出"后面，一眼可见，不再藏进折叠图标。
      // 这组用横向滚动而非换行——保证顶栏永远只占一行的固定高度，
      // 不然棋盘又会被挤出视口（这正是上一轮要解决的问题，不能因为这次改动而复发）。
      '#net-top-btns{display:flex;gap:5px;overflow-x:auto;overflow-y:hidden;flex-shrink:1;',
        'scrollbar-width:none;-ms-overflow-style:none}',
      '#net-top-btns::-webkit-scrollbar{display:none}',
      '#net-top-btns button{flex-shrink:0;background:rgba(255,255,255,.14);',
        'border:1px solid rgba(255,255,255,.32);color:#f2e8d5;border-radius:4px;',
        'padding:4px 9px;cursor:pointer;font:12px "Songti SC","SimSun",serif;white-space:nowrap}',
      '#net-top-btns button:hover{background:rgba(255,255,255,.26)}',
      '#nb-resign{background:#c0392b!important;border-color:#f2c9c9!important}',
      '#nb-resign:hover{background:#d64536!important}',
      // 双方姓名：跟在按钮组后面，固定不滚动；轮到谁走就给谁加亮
      // 注意：这里不能用 margin-left:auto——flex 里的 auto margin 会吸收掉全部剩余空间，
      // 结果把前面的菜单按钮组一起挤到右边。改为普通间距，整条栏保持左对齐。
      '#net-players{flex-shrink:0;min-width:0;max-width:150px;overflow:hidden;',
        'text-overflow:ellipsis;white-space:nowrap;font-size:12px;margin-left:6px}',
      '#net-players .pn{opacity:.68;transition:opacity .15s}',
      '#net-players .pn.on-turn{opacity:1;font-weight:bold;text-shadow:0 0 6px rgba(255,255,255,.5)}',
      '#net-players .sep{opacity:.5;margin:0 3px}',
      '.net-timer{font-size:12px;opacity:.92;font-variant-numeric:tabular-nums;min-width:38px;',
        'text-align:right;flex-shrink:0}',
      // 状态提示：顶栏正下方的小型浮动提示条，只在有事要说时才出现，平时不占任何版面
      '#net-status{position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:2147483645;',
        'display:none;background:rgba(32,29,22,.92);color:#f2e8d5;font-size:12px;',
        'padding:4px 14px;border-radius:0 0 8px 8px;white-space:nowrap;',
        'font-family:"Songti SC","SimSun",serif}',
      '#net-status.show{display:block}',
      // 电脑棋力选择：与AI对弈时才出现，紧凑内联在按钮组里
      '#nb-ailv-wrap{display:none;flex-shrink:0;align-items:center;gap:4px;',
        'background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.32);',
        'border-radius:4px;padding:2px 8px}',
      '#nb-ailv-wrap span{color:#f2e8d5;font-size:11px;opacity:.85;white-space:nowrap}',
      '#nb-ailv-wrap select{padding:2px 4px;font-size:11px;border:1px solid rgba(255,255,255,.4);',
        'border-radius:3px;background:#7a2018;color:#f2e8d5}',
      // 右侧聊天（桌面常驻；顶栏变矮，相应调整 top/bottom）
      '#net-side{position:fixed;top:40px;right:0;bottom:0;width:240px;z-index:2147483646;',
        'display:flex;flex-direction:column;background:#e4dabf;border-left:1px solid #cabd9f;',
        'font:13px "Songti SC","SimSun",serif}',
      '#net-side-hd{flex-shrink:0;padding:7px 12px;border-bottom:1px solid #cabd9f;',
        'font-family:"Kaiti SC","楷体",serif;font-size:.92rem;color:#201d16;letter-spacing:.08em}',
      '#net-chat-log{flex:1;overflow-y:auto;padding:9px 12px;font-size:13px;line-height:1.75;color:#443c30;min-height:0}',
      '.nc-red{color:#9d2c21;font-weight:bold}.nc-blk{color:#201d16;font-weight:bold}',
      '.nc-obs{color:#8a8069;font-weight:bold}.nc-sys{color:#8a8069;font-style:italic;font-size:12px;text-align:center;padding:2px 0}',
      '#net-chat-in{flex-shrink:0;display:flex;border-top:1px solid #cabd9f;padding:6px 8px;gap:6px;background:#e4dabf}',
      '#net-chat-in input{flex:1;border:1px solid #cabd9f;border-radius:4px;padding:5px 8px;',
        'background:#ece3d0;font:13px "Songti SC","SimSun",serif;color:#201d16;outline:none}',
      '#net-chat-in input:focus{border-color:#9d2c21}',
      '#net-send{background:#9d2c21;color:#f2e8d5;border:0;border-radius:4px;padding:5px 10px;cursor:pointer;font:13px "Songti SC",serif}',
      // 复盘导航条：底栏已取消，改贴在屏幕最下方悬浮
      '#net-rv-bar{position:fixed;bottom:0;left:0;right:240px;z-index:2147483647;',
        'display:none;align-items:center;gap:6px;padding:5px 10px;',
        'background:#ece3d0;border-top:1px solid #cabd9f;font:12px "Songti SC","SimSun",serif}',
      '#net-rv-bar button{background:#ece3d0;border:1px solid #cabd9f;border-radius:4px;padding:4px 9px;cursor:pointer}',
      '#net-rv-bar span{flex:1;text-align:center;color:#8a8069}',
      // 请求通知条（悔棋/求和）
      '#net-req-bar{position:fixed;top:40px;left:0;right:240px;z-index:2147483647;',
        'display:none;align-items:center;gap:10px;padding:8px 14px;',
        'background:#7a5c14;color:#fff;font:13px "Songti SC","SimSun",serif}',
      '#net-req-bar button{background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.5);',
        'border-radius:4px;color:#fff;padding:3px 10px;cursor:pointer;font:13px "Songti SC",serif}',
      // 手机：聊天做成底部抽屉，默认收起；菜单同样悬浮展开，均不占常驻版面
      '@media(max-width:580px){',
        '#net-side{top:auto;left:0;right:0;bottom:0;width:auto;height:56vh;',
          'border-left:0;border-top:2px solid #9d2c21;border-radius:12px 12px 0 0;',
          'transform:translateY(100%);transition:transform .25s ease;',
          'box-shadow:0 -6px 20px rgba(0,0,0,.25)}',
        '#net-side.open{transform:translateY(0)}',
        '#net-rv-bar{right:0}',
        '#net-req-bar{right:0}',
        '#net-top{gap:5px;padding:0 7px}',
        '#net-top b{font-size:.85rem}',
        '#net-players{display:none}',   // 手机顶栏太窄，姓名让位；聊天记录里仍能看到双方是谁
        // 按钮组挪到棋盘下方后的样式：不再是顶栏里的横向滚动条，
        // 改为正常文档流的一块，铺满宽度、按钮自由换行，空间比顶栏宽裕得多
        '#net-top-btns.below-board{position:static;display:flex;flex-wrap:wrap;',
          'gap:7px;padding:12px 12px 18px;overflow:visible;height:auto;',
          'background:#e4dabf;border-top:2px solid #9d2c21}',
        '#net-top-btns.below-board button{flex:1 1 auto;min-width:84px;',
          'text-align:center;background:#f3ead6;border:1px solid #cabd9f;',
          'color:#443c30;padding:9px 8px;font-size:13px;border-radius:6px}',
        '#net-top-btns.below-board button:hover{border-color:#9d2c21;color:#9d2c21}',
        '#net-top-btns.below-board #nb-resign{background:#9d2c21!important;',
          'color:#f2e8d5!important;border-color:#9d2c21!important}',
        '#net-top-btns.below-board #nb-ailv-wrap{flex:1 1 100%;background:#f3ead6;',
          'border:1px solid #cabd9f;color:#443c30;padding:7px 10px}',
        '#net-top-btns.below-board #nb-ailv-wrap span{color:#8a8069}',
        '#net-top-btns.below-board #nb-ailv-wrap select{background:#fff;color:#443c30;',
          'border:1px solid #cabd9f}',
      '}',
      '#nb-unread{background:#9d2c21;color:#fff;border-radius:9px;',
        'padding:0 5px;font-size:11px;margin-left:5px}'
    ].join('');
    document.head.appendChild(st);

    // ── 顶栏：单条横排——象棋室 · 退出 · 菜单按钮组(横向可滚动) · 姓名(轮到谁走即高亮) · 计时 ──
    // 按钮组直接铺开在"退出"后面，一眼可见，不再藏进折叠图标；
    // 组内用横向滚动而非换行，顶栏高度始终固定 40px，棋盘可用空间不受影响。
    var top=document.createElement('div'); top.id='net-top';
    var timerStr=(optTotal||optPerMove)
      ? '<span class="net-timer" id="ntR" title="红方时间">—</span><span class="net-timer" id="ntB" title="黑方时间">—</span>'
      : '';
    top.innerHTML='<b>象棋室</b>'
      +'<a href="../" id="net-exit">退出</a>'
      +'<span id="net-players">'
        +'<span class="pn" id="pn-red">红：—</span>'
        +'<span class="sep">·</span>'
        +'<span class="pn" id="pn-black">黑：—</span>'
      +'</span>'
      +timerStr;

    // 菜单按钮组：独立元素，按屏幕宽度决定放哪——
    // 桌面横向空间足够，放进顶栏里（横排，放不下就横向滚动）；
    // 手机顶栏太窄放不下，改放在棋盘下方（那里空间充足，正常文档流，
    // 不会影响棋盘自身的尺寸计算，放不下就让整页往下滚一点即可）。
    var btns=document.createElement('div'); btns.id='net-top-btns';
    btns.innerHTML='<button id="nb-opts">⚙ 设置</button>'
      +'<button id="nb-endgame">🏳 结束棋局</button>'
      +'<span id="nb-ailv-wrap"><span>棋力</span><select id="nb-ailv"></select></span>'
      +'<button id="nb-chat">聊天<span id="nb-unread"></span></button>'
      +'<button id="nb-undo">悔棋</button>'
      +'<button id="nb-draw">求和</button>'
      +'<button id="nb-flip">↕ 翻转</button>'
      +'<button id="nb-review">🔍 复盘</button>'
      +'<button id="nb-resign">认输</button>';
    var isMobileLayout = window.innerWidth<=580;
    if(isMobileLayout) btns.classList.add('below-board');

    // 顶栏正下方的小提示条（原来常驻的"轮到你走"文字改成这个，只在有事要说时才弹出）
    var statusEl=document.createElement('div'); statusEl.id='net-status';

    var side=document.createElement('div'); side.id='net-side';
    side.innerHTML='<div id="net-side-hd">对局聊天　<span style="font-size:.75rem;color:#8a8069">（点此收起）</span></div>'
      +'<div id="net-chat-log"></div>'
      +'<div id="net-chat-in"><input id="net-msg" maxlength="200" placeholder="说点什么…" autocomplete="off"><button id="net-send">发</button></div>';

    var rvBar=document.createElement('div'); rvBar.id='net-rv-bar';
    rvBar.innerHTML='<button id="nb-rv-first">⏮</button><button id="nb-rv-prev">◀</button>'
      +'<span id="nb-rv-st"></span>'
      +'<button id="nb-rv-next">▶</button><button id="nb-rv-last">⏭</button>'
      +'<button id="nb-rv-exit">退出复盘</button>';

    var reqBar=document.createElement('div'); reqBar.id='net-req-bar';
    reqBar.innerHTML='<span id="req-text"></span><button id="req-yes">同意</button><button id="req-no">拒绝</button>';

    document.body.appendChild(top);
    // 按钮组：桌面挂进顶栏（横排）；手机挂到 body 末尾（自然落在棋盘下方，
    // 正常文档流，不影响棋盘尺寸计算，放不下就随页面滚动到）
    if(isMobileLayout) document.body.appendChild(btns);
    else top.appendChild(btns);
    document.body.appendChild(statusEl);
    document.body.appendChild(side);
    document.body.appendChild(rvBar);
    document.body.appendChild(reqBar);


    elStatus  =document.getElementById('net-status');
    elPlayers =document.getElementById('net-players');
    elChatLog =document.getElementById('net-chat-log');
    elChatIn  =document.getElementById('net-msg');
    elTimerR  =document.getElementById('ntR');
    elTimerB  =document.getElementById('ntB');

    // 悔棋
    document.getElementById('nb-undo').onclick=function(){
      if(isSpectator){setStatus('观战者不能请求悔棋');return;}
      if(aiSeat && aiDriving){
        // 与电脑对弈：一次撤两步（电脑应招 + 自己那步），一次点击即回到自己该走的局面
        socket.emit('undo:ai');
        setStatus('已悔棋一手');
        return;
      }
      socket.emit('undo:request'); setStatus('已请求悔棋，等待对方同意…');
    };
    // 求和（对方同意才判和）
    document.getElementById('nb-draw').onclick=function(){
      if(isSpectator){ setStatus('观战者不能求和'); return; }
      if(aiSeat && aiDriving){ setStatus('与电脑对弈不支持求和'); return; }
      socket.emit('draw:request'); setStatus('已提出和棋，等待对方回应…');
    };
    // 翻转
    document.getElementById('nb-flip').onclick=function(){
      try{ boardFlipped=!boardFlipped; if(typeof draw==='function')draw(); }catch(e){}
    };
    // 复盘
    document.getElementById('nb-review').onclick=function(){
      try{ document.getElementById('review-btn').click(); }catch(e){}
      rvBar.style.display='flex';
    };
    ['first','prev','next','last'].forEach(function(k){
      var nb=document.getElementById('nb-rv-'+k);
      var ob=document.getElementById('review-'+k);
      if(nb&&ob) nb.onclick=function(){
        ob.click();
        try{ var rs=document.getElementById('review-status');
          if(rs)document.getElementById('nb-rv-st').textContent=rs.textContent; }catch(e){}
      };
    });
    document.getElementById('nb-rv-exit').onclick=function(){
      try{ document.getElementById('review-exit').click(); }catch(e){}
      rvBar.style.display='none';
    };
    // 认输
    document.getElementById('nb-resign').onclick=function(){
      if(isSpectator)return;
      showConfirm('确认认输？', function(){ stopTimer(); socket.emit('resign'); });
    };
    // 结束棋局，返回大厅：不再走认输/求和流程，直接把这桌标记结束并离开
    document.getElementById('nb-endgame').onclick=function(){
      showConfirm('结束本局并返回大厅？', function(){
        stopTimer();
        if(!isSpectator) socket.emit('table:leave');
        location.href='../';
      });
    };
    document.getElementById('nb-opts').onclick=function(){
      buildOptsPanel();
      var p=document.getElementById('net-opts-panel');
      p.style.display = (p.style.display==='none') ? 'block' : 'none';
    };
    // 与电脑对弈：对局设置无意义（无对手协商），隐藏该按钮
    if(aiSeat){ var ob=document.getElementById('nb-opts'); if(ob) ob.style.display='none'; }
    // 退出：直接返回大厅，不再弹窗确认
    // 手机端聊天抽屉
    var chatOpen=false, unread=0;
    function toggleChat(open){
      var side=document.getElementById('net-side');
      chatOpen=(open===undefined)?!chatOpen:open;
      if(side) side.classList.toggle('open',chatOpen);
      if(chatOpen){ unread=0; var u=document.getElementById('nb-unread'); if(u) u.style.display='none'; }
    }
    window.__netBumpUnread=function(){
      if(chatOpen) return;
      if(window.innerWidth>580) return;
      unread++;
      var u=document.getElementById('nb-unread');
      if(u){ u.textContent=unread; u.style.display='inline-block'; }
    };
    document.getElementById('nb-chat').onclick=function(){ toggleChat(); };
    document.getElementById('net-side-hd').onclick=function(){
      if(window.innerWidth<=580) toggleChat(false);
    };

    // 聊天
    function sendChat(){ var v=(elChatIn.value||'').trim(); if(v){ socket.emit('chat',{text:v}); elChatIn.value=''; } }
    document.getElementById('net-send').onclick=sendChat;
    elChatIn.addEventListener('keydown',function(e){ if(e.key==='Enter')sendChat(); });

    // 电脑棋力下拉：与电脑对弈时才显示，可随时换级（下一手生效）
    (function(){
      var sel=document.getElementById('nb-ailv');
      var names={1:'新手',2:'入门',3:'业余',4:'棋手',5:'高手',6:'棋协大师',7:'大师',8:'特级大师',9:'引擎巅峰'};
      var html='';
      for(var l=1;l<=9;l++) html+='<option value="'+l+'">'+l+'级 '+names[l]+'</option>';
      sel.innerHTML=html;
      sel.onchange=function(){
        var lv=parseInt(sel.value)||6;
        aiLv=lv;
        try{ aiLevel=lv; }catch(e){}
        if(typeof prepEngineForLevel==='function') prepEngineForLevel(lv);
        warmUpEngine();
        setStatus('电脑棋力已改为 '+lv+' 级');
        addChat({name:'系统',seat:'',text:'电脑棋力改为 '+lv+' 级 '+names[lv]});
      };
      refreshAiLvUI();
    })();

    markGameKind();     // 首次建界面时先定好对局类型，避免原生控件闪现/误禁

    // 残局/测评是自成一体的单机玩法，进出时会本地 reset 棋盘。
    // 退出回到联网对局时，本地局面已被清掉而服务器仍留着原局，
    // 这里侦测"退出"的瞬间，向服务器要一次全量同步把棋局接回来。
    (function watchSoloExit(){
      var wasSolo = isLocalSoloMode();
      setInterval(function(){
        var nowSolo = isLocalSoloMode();
        if(wasSolo && !nowSolo){
          try{
            socket.emit('sync:request');
            setStatus('已退出单机玩法，正在接回原对局…');
          }catch(e){}
        }
        if(wasSolo !== nowSolo){
          wasSolo = nowSolo;
          markGameKind();
        }
      }, 800);
    })();

    // 引擎文件自检：缺失时明确提示，避免"强AI默默变内置AI"
    checkEngineFiles();

    // 初始化计时器显示
    if(optTotal){
      timer.red.rem=optTotal; timer.black.rem=optTotal;
    } else if(optPerMove){
      timer.red.rem=optPerMove; timer.black.rem=optPerMove;
    }
    updateTimerDisplay();
  }

  // ── 对局设置面板：对弈方式/让子，双方都能看到当前设置并同步 ──────
  var curOptions={type:'free',perMove:0,total:0,handicap:''};
  function buildOptsPanel(){
    if(document.getElementById('net-opts-panel')) return;
    var isRed=(myColor==='r');
    var p=document.createElement('div');
    p.id='net-opts-panel';
    // 底栏已取消，改居中悬浮弹出
    p.style.cssText='display:none;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);'
      +'z-index:2147483647;background:#ece3d0;border:2px solid #9d2c21;border-radius:10px;'
      +'padding:16px 20px;box-shadow:0 8px 28px rgba(0,0,0,.35);'
      +'font-family:"Songti SC","SimSun",serif;min-width:260px;max-width:90vw';
    p.innerHTML='<div style="font-family:\'Kaiti SC\',\'楷体\',serif;font-size:1rem;'
      +'color:#201d16;margin-bottom:10px;letter-spacing:.08em">对局设置</div>'
      +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:.88rem">'
        +'<label style="color:#8a8069;min-width:56px">方式</label>'
        +'<select id="np-o-type" style="padding:4px 7px"'+(isRed?'':' disabled')+'>'
          +'<option value="free">自由（不限时）</option>'
          +'<option value="timed">计时对弈</option>'
        +'</select></div>'
      +'<div id="np-o-timed" style="display:none">'
        +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:.88rem">'
          +'<label style="color:#8a8069;min-width:56px">每步</label>'
          +'<select id="np-o-per" style="padding:4px 7px"'+(isRed?'':' disabled')+'>'
            +'<option value="0">不限</option><option value="30">30秒</option>'
            +'<option value="60">60秒</option><option value="180">3分</option>'
          +'</select></div>'
        +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:.88rem">'
          +'<label style="color:#8a8069;min-width:56px">全局</label>'
          +'<select id="np-o-tot" style="padding:4px 7px"'+(isRed?'':' disabled')+'>'
            +'<option value="0">不限</option><option value="600">10分</option>'
            +'<option value="1200">20分</option><option value="1800">30分</option>'
          +'</select></div>'
      +'</div>'
      +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:.88rem">'
        +'<label style="color:#8a8069;min-width:56px">让子</label>'
        +'<select id="np-o-han" style="padding:4px 7px"'+(isRed?'':' disabled')+'>'
          +'<option value="">无</option><option value="horse1">红让单马</option>'
          +'<option value="horse2">红让双马</option><option value="cannon1">红让单炮</option>'
          +'<option value="rook1">红让单车</option>'
        +'</select></div>'
      +(isRed?'':'<div style="font-size:.78rem;color:#8a8069;margin-bottom:10px">设置由红方调整，此处仅供查看</div>')
      +'<div style="text-align:right"><button id="np-o-close" style="background:#9d2c21;color:#f2e8d5;'
        +'border:0;border-radius:5px;padding:5px 16px;cursor:pointer;font-family:\'Kaiti SC\',serif">关闭</button></div>';
    document.body.appendChild(p);

    document.getElementById('np-o-close').onclick=function(){ p.style.display='none'; };
    var tsel=document.getElementById('np-o-type');
    tsel.onchange=function(){
      document.getElementById('np-o-timed').style.display = tsel.value==='timed'?'block':'none';
      if(isRed) emitOpts();
    };
    ['np-o-per','np-o-tot','np-o-han'].forEach(function(id){
      var el=document.getElementById(id);
      if(el) el.onchange=function(){ if(isRed) emitOpts(); };
    });
  }
  function emitOpts(){
    var t=document.getElementById('np-o-type').value;
    curOptions={
      type:t,
      perMove:parseInt(document.getElementById('np-o-per').value)||0,
      total:parseInt(document.getElementById('np-o-tot').value)||0,
      handicap:document.getElementById('np-o-han').value
    };
    if(window.__netSocket) window.__netSocket.emit('table:options',curOptions);
  }
  function applyOptsToPanel(o){
    curOptions=o||curOptions;
    var t=document.getElementById('np-o-type'); if(!t) return;
    t.value=curOptions.type||'free';
    document.getElementById('np-o-timed').style.display=(curOptions.type==='timed')?'block':'none';
    document.getElementById('np-o-per').value=String(curOptions.perMove||0);
    document.getElementById('np-o-tot').value=String(curOptions.total||0);
    document.getElementById('np-o-han').value=curOptions.handicap||'';
  }

  // 自定义确认框：替代浏览器原生 confirm()——原生弹窗会带出网址且是英文按钮，
  // 这里做成页面内浮层，只显示中文文字和「确认/取消」两个按钮
  function showConfirm(text, onYes){
    var old=document.getElementById('net-confirm');
    if(old) old.remove();
    var box=document.createElement('div');
    box.id='net-confirm';
    box.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(32,29,22,.5);'
      +'display:flex;align-items:center;justify-content:center';
    box.innerHTML='<div style="background:#ece3d0;border:2px solid #9d2c21;border-radius:10px;'
        +'padding:22px 26px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.35);'
        +'font-family:\'Songti SC\',\'SimSun\',serif;min-width:220px;max-width:86vw">'
      +'<div style="color:#201d16;font-size:.95rem;margin-bottom:18px;line-height:1.6">'+esc(text)+'</div>'
      +'<div style="display:flex;gap:10px;justify-content:center">'
        +'<button id="nc-yes" style="background:#9d2c21;color:#f2e8d5;border:0;border-radius:6px;'
          +'padding:7px 20px;cursor:pointer;font-family:\'Kaiti SC\',\'楷体\',serif;font-size:.9rem">确认</button>'
        +'<button id="nc-no" style="background:#e4dabf;color:#443c30;border:1px solid #cabd9f;'
          +'border-radius:6px;padding:7px 20px;cursor:pointer;font-family:\'Songti SC\',serif;font-size:.9rem">取消</button>'
      +'</div></div>';
    document.body.appendChild(box);
    document.getElementById('nc-yes').onclick=function(){ box.remove(); onYes(); };
    document.getElementById('nc-no').onclick=function(){ box.remove(); };
  }

  // ── 悔棋/求和通知条（替代 confirm，避免浏览器拦截）──────────
  var reqTimer=null;
  function showRequest(text, onAccept, onReject){
    var bar=document.getElementById('net-req-bar');
    if(!bar) return;
    document.getElementById('req-text').textContent=text;
    bar.style.display='flex';
    clearTimeout(reqTimer);
    var yes=document.getElementById('req-yes');
    var no =document.getElementById('req-no');
    yes.onclick=function(){ bar.style.display='none'; onAccept(); };
    no.onclick =function(){ bar.style.display='none'; onReject(); };
    reqTimer=setTimeout(function(){ bar.style.display='none'; onReject(); },30000);
  }
  function showUndoRequest(socket){
    showRequest('对方请求悔棋一手，是否同意？',
      function(){ socket.emit('undo:accept'); setStatus('已同意悔棋'); },
      function(){ socket.emit('undo:reject'); setStatus('已拒绝悔棋'); }
    );
  }
  function showDrawRequest(socket){
    showRequest('对方提出和棋，是否同意？',
      function(){ socket.emit('draw:accept'); },
      function(){ socket.emit('draw:reject'); setStatus('已拒绝和棋'); }
    );
  }

  // ── 工具 ─────────────────────────────────────────────────────
  // 轮到谁走：不再用文字提示（那是与棋盘自身重复的信息），
  // 改为给顶栏里对应一方的姓名加亮（加粗、发光），棋局进行中始终如此、不占额外版面
  function refreshTurn(){
    try{
      var t=(typeof turn!=='undefined')?turn:null;
      var pr=document.getElementById('pn-red'), pb=document.getElementById('pn-black');
      if(pr) pr.classList.toggle('on-turn', t==='r');
      if(pb) pb.classList.toggle('on-turn', t==='b');
    }catch(e){}
  }
  // 顶栏下方的小提示条：只用于真正的临时消息（悔棋/求和往来、断线、引擎加载中等），
  // 显示几秒后自动淡出，不再"回落显示轮到谁走"（那部分已经交给姓名高亮）
  function setStatus(txt,persist){
    if(!elStatus) return;
    elStatus.textContent=txt;
    elStatus.classList.add('show');
    clearTimeout(setStatus._t);
    if(!persist) setStatus._t=setTimeout(function(){ elStatus.classList.remove('show'); },4000);
  }
  function setPlayers(p){
    var pr=document.getElementById('pn-red'), pb=document.getElementById('pn-black');
    if(pr) pr.textContent='红：'+(p.red||'空');
    if(pb) pb.textContent='黑：'+(p.black||'空');
    // 观战人数附在黑方名字后，不再单独占一段
    if(pb && p.spectators) pb.textContent += '　（观'+p.spectators+'）';
  }
  function addChat(m){
    if(!elChatLog) return;
    var d=document.createElement('div');
    if(m.name==='系统'){ d.className='nc-sys'; d.textContent='—— '+m.text+' ——'; }
    else{
      var cls=m.seat==='red'?'nc-red':m.seat==='black'?'nc-blk':'nc-obs';
      var who=m.seat==='red'?'红':m.seat==='black'?'黑':'观';
      d.innerHTML='<span class="'+cls+'">'+esc(m.name)+'</span>'
        +' <span style="color:#cabd9f;font-size:11px">('+who+')</span>：'+esc(m.text);
    }
    elChatLog.appendChild(d); elChatLog.scrollTop=elChatLog.scrollHeight;
  }
  // 对局结束面板：再来一局 / 返回大厅
  function showEndPanel(reason){
    // 延迟弹出：先让棋盘播完"祝贺取得胜利"的画面
    clearTimeout(showEndPanel._t);
    showEndPanel._t=setTimeout(function(){ buildEndPanel(reason); }, 2600);
  }
  function buildEndPanel(reason){
    var old=document.getElementById('net-end-panel');
    if(old) old.remove();
    var p=document.createElement('div');
    p.id='net-end-panel';
    // 棋盘正下方的横条：底栏已取消，直接贴屏幕最下沿
    p.style.cssText='position:fixed;left:0;right:240px;bottom:0;'
      +'z-index:2147483646;background:#f3ead6;border-top:2px solid #9d2c21;'
      +'padding:9px 14px;display:flex;align-items:center;gap:12px;justify-content:center;'
      +'font-family:"Songti SC","SimSun",serif;box-shadow:0 -3px 12px rgba(0,0,0,.12)';
    if(window.innerWidth<=580) p.style.right='0';
    p.innerHTML='<span style="color:#9d2c21;font-size:.95rem">'+esc(reason||'对局结束')+'</span>'
      +'<span style="display:flex;gap:8px">'
        +(isSpectator?'':'<button id="np-again" style="background:#4a7c59;color:#fff;border:0;'
          +'border-radius:5px;padding:6px 16px;cursor:pointer;font-family:\'Kaiti SC\',serif;'
          +'font-size:.9rem;letter-spacing:.08em">再来一局</button>')
        +'<a href="../" style="background:#9d2c21;color:#f2e8d5;text-decoration:none;'
          +'border-radius:5px;padding:6px 16px;font-family:\'Kaiti SC\',serif;'
          +'font-size:.9rem;letter-spacing:.08em">返回大厅</a>'
      +'</span>';
    document.body.appendChild(p);
    var again=document.getElementById('np-again');
    if(again) again.onclick=function(){
      if(window.__netSocket) window.__netSocket.emit('table:rematch');
      again.textContent='等待对方…'; again.disabled=true;
    };
  }
  function hideEndPanel(){
    clearTimeout(showEndPanel._t);
    var p=document.getElementById('net-end-panel');
    if(p) p.remove();
  }

  function showBanner(t){
    var d=document.createElement('div');
    d.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#9d2c21;color:#fff;display:flex;align-items:center;justify-content:center;font:16px serif;text-align:center;padding:20px';
    d.textContent=t; document.body.appendChild(d);
  }
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
})();
