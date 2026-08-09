/* 立山象棋 · 联网层 v6
 * 加到 index.html 末尾：<script src="netplay.js"></script>
 * 仅当 URL 带 ?table=... 时激活；否则离线版行为完全不变。
 */
(function(){
  var params  = new URLSearchParams(location.search);
  var tableId = params.get('table');
  if (!tableId) return;

  var seatWanted = decodeURIComponent(params.get('seat')   || 'auto');
  var myName     = decodeURIComponent(params.get('name')   || '访客');
  var optPerMove = parseInt(params.get('perMove')) || 0;   // 每步时限（秒）
  var optTotal   = parseInt(params.get('total'))   || 0;   // 全局时间（秒/方）
  var optHandicap= decodeURIComponent(params.get('handicap') || '');  // 让子

  // 每标签独立 PID
  var PID = sessionStorage.getItem('lsz_pid');
  if (!PID){ PID='p'+Math.random().toString(36).slice(2)+Date.now().toString(36); sessionStorage.setItem('lsz_pid',PID); }

  var myColor=null, isSpectator=false;
  var applyingRemote=false, appliedCount=0;
  var uiBuilt=false, hooksSet=false;
  window.__netMode = false;

  // 如果只有 aiLevel 参数（无 table），纯单机 AI 模式：设好棋力后直接返回
  var aiLevelParam = parseInt(params.get('aiLevel'))||0;
  if(aiLevelParam && !tableId){
    // 纯单机 AI 模式：设棋力 + 加"返回棋室"按钮，不启动联网层
    function setupAiMode(){
      // 设棋力
      try{
        aiLevel = aiLevelParam;
        if(typeof redAiLevel!=='undefined') redAiLevel=aiLevelParam;
        if(typeof refreshTriggerLabels==='function') refreshTriggerLabels();
        if(typeof prepEngineForLevel==='function') prepEngineForLevel(aiLevelParam);
      }catch(e){}
      // 加"返回棋室"按钮（右上角红色小标签）
      var btn=document.createElement('a');
      btn.href='../';
      btn.textContent='← 返回棋室';
      btn.style.cssText='position:fixed;top:8px;right:12px;z-index:9999999;'
        +'color:#f2e8d5;background:#9d2c21;text-decoration:none;'
        +'padding:4px 12px;border-radius:4px;font:12px "Songti SC","SimSun",serif;'
        +'box-shadow:0 2px 8px rgba(0,0,0,.25);letter-spacing:.05em';
      document.body.appendChild(btn);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',setupAiMode);
    else setTimeout(setupAiMode, 300);
    return;   // 不启动联网层
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
  function applyHandicap(){
    if(!optHandicap||optHandicap==='none') return;
    try{
      // 扫描棋盘，按需移除红方棋子
      var removed=0;
      for(var r=ROWS-1;r>=0;r--){
        for(var c=COLS-1;c>=0;c--){
          var p=board[r][c];
          if(!p||p.side!=='r') continue;
          if(optHandicap==='horse1'  && p.type==='M' && removed<1){ board[r][c]=null; removed++; }
          if(optHandicap==='horse2'  && p.type==='M')               { board[r][c]=null; }
          if(optHandicap==='cannon1' && p.type==='P' && removed<1){ board[r][c]=null; removed++; }
          if(optHandicap==='rook1'   && p.type==='C' && removed<1){ board[r][c]=null; removed++; }
          if(optHandicap==='rook_horse'&&(p.type==='C'||p.type==='M')&&removed<2){ board[r][c]=null; removed++; }
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
      if(!uiBuilt){
        skipIntro(function(){
          buildNetUI(socket);
          uiBuilt=true;
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
    socket.on('move', function(m){
      if(!m||typeof m.idx!=='number') return;
      if     (m.idx===appliedCount){ applyRemote(m); appliedCount++; onMoveMade(m.by, socket); refreshTurn(); }
      else if(m.idx < appliedCount){ /* 忽略 */ }
      else   { socket.emit('sync:request'); }
    });
    socket.on('chat',          function(m){ addChat(m); });
    socket.on('table:players', function(p){ setPlayers(p); });
    socket.on('table:over',    function(o){ stopTimer(); setStatus(o.reason||'对局结束',true); });
    socket.on('disconnect',    function(){ setStatus('连接中断，重连中…'); });

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
    try{ mode='pvp'; aiSide=null; }catch(e){}
    if(typeof triggerAI==='function'&&!triggerAI.__net){
      var _t=triggerAI;
      window.triggerAI=function(){ if(window.__netMode)return; return _t.apply(this,arguments); };
      window.triggerAI.__net=true;
    }
    if(typeof makeMove==='function'&&!makeMove.__net){
      var _m=makeMove;
      window.makeMove=function(fr,fc,tr,tc){
        try{ aiThinking=false; }catch(e){}
        if(window.__netMode&&isSpectator&&!applyingRemote) return;
        if(window.__netMode&&!applyingRemote&&myColor&&typeof turn!=='undefined'&&turn!==myColor) return;
        var r=_m(fr,fc,tr,tc);
        if(window.__netMode&&!applyingRemote){
          appliedCount++;
          socket.emit('move',{fr:fr,fc:fc,tr:tr,tc:tc});
          var side=myColor==='r'?'red':'black';
          onMoveMade(side, socket);
          refreshTurn();
        }
        return r;
      };
      window.makeMove.__net=true;
    }
  }

  // ── 同步棋局 ─────────────────────────────────────────────────
  function doSync(st, socket){
    applyingRemote=true; appliedCount=0;
    try{ if(typeof reset==='function') reset(); }catch(e){}
    try{ (st.moves||[]).forEach(function(m){ makeMove(m.fr,m.fc,m.tr,m.tc); appliedCount++; }); }catch(e){}
    applyingRemote=false;
    try{ turn=st.turn||'r'; if(typeof draw==='function') draw(); }catch(e){}
    try{
      if(!isSpectator&&myColor==='b'&&typeof boardFlipped!=='undefined'&&!boardFlipped){
        boardFlipped=true; if(typeof draw==='function') draw();
      }
    }catch(e){}
    // 应用让子
    if(optHandicap && st.moves && st.moves.length===0) applyHandicap();
    setPlayers(st.seats||{});
    refreshTurn();
  }

  function applyRemote(m){
    applyingRemote=true;
    try{ makeMove(m.fr,m.fc,m.tr,m.tc); }catch(e){}
    applyingRemote=false;
    try{ if(typeof draw==='function') draw(); }catch(e){}
  }

  function skipIntro(onDone){
    function doSkip(){
      try{
        var btn=document.getElementById('intro-enter-btn');
        var scr=document.getElementById('intro-screen');
        if(btn) btn.click(); else if(scr) scr.style.display='none';
      }catch(e){}
      setTimeout(function(){ if(typeof onDone==='function') onDone(); },680);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',doSkip);
    else doSkip();
  }

  // ── 构建叠加 UI ──────────────────────────────────────────────
  var elStatus,elPlayers,elChatLog,elChatIn;

  function buildNetUI(socket){
    var st=document.createElement('style'); st.id='net-style';
    st.textContent=[
      // 隐藏 AI 控件
      '#trig-level,#trig-redlevel,#trig-blacklevel,#trig-mode,',
      '#mtrig-level,#mtrig-mode,#endgame-btn,#assess-btn,#restart,',
      '#draw-btn,#hint-btn,#undo,#mm-btn{display:none!important}',
      'body{padding-top:42px!important}',
      // 顶栏
      '#net-top{position:fixed;top:0;left:0;right:0;height:42px;z-index:2147483647;',
        'display:flex;align-items:center;gap:8px;padding:0 12px;',
        'background:#9d2c21;color:#f2e8d5;font:13px "Songti SC","SimSun",serif}',
      '#net-top b{font-family:"Kaiti SC","STKaiti","楷体",serif;font-size:.95rem;letter-spacing:.1em}',
      '#net-players{flex:1;font-size:12px;opacity:.9}',
      '#net-status{font-size:12px;background:rgba(0,0,0,.2);padding:2px 9px;border-radius:10px;white-space:nowrap}',
      '#net-top a{color:#f2e8d5;text-decoration:none;font-size:12px;opacity:.8;',
        'padding:2px 7px;border:1px solid rgba(255,255,255,.3);border-radius:4px}',
      '#net-top a:hover{opacity:1}',
      // 计时器（在顶栏右侧）
      '.net-timer{font-size:12px;opacity:.9;font-variant-numeric:tabular-nums;min-width:54px;text-align:right}',
      // 右侧聊天
      '#net-side{position:fixed;top:42px;right:0;bottom:52px;width:240px;z-index:2147483646;',
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
      // 底栏
      '#net-bar{position:fixed;bottom:0;left:0;right:0;height:52px;z-index:2147483647;',
        'display:flex;align-items:center;gap:7px;padding:0 10px;',
        'background:#e4dabf;border-top:1px solid #cabd9f;font:13px "Songti SC","SimSun",serif}',
      '#net-bar button{background:#ece3d0;border:1px solid #cabd9f;border-radius:5px;',
        'padding:5px 11px;cursor:pointer;color:#443c30;font:13px "Songti SC","SimSun",serif;transition:.2s}',
      '#net-bar button:hover{border-color:#9d2c21;color:#9d2c21}',
      '#net-bar .sp{flex:1}',
      '#nb-resign{color:#9d2c21!important;border-color:#c0392b!important}',
      '#nb-resign:hover{background:#9d2c21!important;color:#f2e8d5!important}',
      // 复盘条
      '#net-rv-bar{position:fixed;bottom:52px;left:0;right:0;z-index:2147483647;',
        'display:none;align-items:center;gap:6px;padding:4px 10px;',
        'background:#ece3d0;border-top:1px solid #cabd9f;font:12px "Songti SC","SimSun",serif}',
      '#net-rv-bar button{background:#ece3d0;border:1px solid #cabd9f;border-radius:4px;padding:4px 9px;cursor:pointer}',
      '#net-rv-bar span{flex:1;text-align:center;color:#8a8069}',
      // 请求通知条（悔棋/求和）
      '#net-req-bar{position:fixed;top:42px;left:0;right:240px;z-index:2147483647;',
        'display:none;align-items:center;gap:10px;padding:8px 14px;',
        'background:#7a5c14;color:#fff;font:13px "Songti SC","SimSun",serif}',
      '#net-req-bar button{background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.5);',
        'border-radius:4px;color:#fff;padding:3px 10px;cursor:pointer;font:13px "Songti SC",serif}',
      '@media(max-width:580px){#net-side{top:auto;bottom:130px;left:0;right:0;width:auto;height:160px;border-left:0;border-top:1px solid #cabd9f}#net-bar{bottom:160px}body{padding-top:42px!important;padding-bottom:216px!important}}'
    ].join('');
    document.head.appendChild(st);

    // 搭叠加层
    var top=document.createElement('div'); top.id='net-top';
    var timerStr=(optTotal||optPerMove) ? '<span class="net-timer" id="ntR" title="红方时间">—</span>|<span class="net-timer" id="ntB" title="黑方时间">—</span>' : '';
    top.innerHTML='<b>立山斋象棋室</b>'
      +'<span id="net-players">—</span>'
      +'<span id="net-status">连接中…</span>'
      +timerStr
      +'<a href="../" id="net-exit">退出</a>';

    var side=document.createElement('div'); side.id='net-side';
    side.innerHTML='<div id="net-side-hd">对局聊天</div>'
      +'<div id="net-chat-log"></div>'
      +'<div id="net-chat-in"><input id="net-msg" maxlength="200" placeholder="说点什么…" autocomplete="off"><button id="net-send">发</button></div>';

    var bar=document.createElement('div'); bar.id='net-bar';
    bar.innerHTML='<button id="nb-undo">悔棋请求</button>'
      +'<button id="nb-flip">↕ 翻转</button>'
      +'<button id="nb-review">🔍 复盘</button>'
      +'<div class="sp"></div>'
      +'<button id="nb-resign">认输</button>';

    var rvBar=document.createElement('div'); rvBar.id='net-rv-bar';
    rvBar.innerHTML='<button id="nb-rv-first">⏮</button><button id="nb-rv-prev">◀</button>'
      +'<span id="nb-rv-st"></span>'
      +'<button id="nb-rv-next">▶</button><button id="nb-rv-last">⏭</button>'
      +'<button id="nb-rv-exit">退出复盘</button>';

    var reqBar=document.createElement('div'); reqBar.id='net-req-bar';
    reqBar.innerHTML='<span id="req-text"></span><button id="req-yes">同意</button><button id="req-no">拒绝</button>';

    document.body.appendChild(top);
    document.body.appendChild(side);
    document.body.appendChild(bar);
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
      socket.emit('undo:request'); setStatus('已请求悔棋，等待对方同意…');
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
      if(confirm('确认认输？')){ stopTimer(); socket.emit('resign'); }
    };
    // 退出
    document.getElementById('net-exit').onclick=function(e){
      if(!confirm('确认退出当前对局？')){ e.preventDefault(); }
    };
    // 聊天
    function sendChat(){ var v=(elChatIn.value||'').trim(); if(v){ socket.emit('chat',{text:v}); elChatIn.value=''; } }
    document.getElementById('net-send').onclick=sendChat;
    elChatIn.addEventListener('keydown',function(e){ if(e.key==='Enter')sendChat(); });

    // 初始化计时器显示
    if(optTotal){
      timer.red.rem=optTotal; timer.black.rem=optTotal;
    } else if(optPerMove){
      timer.red.rem=optPerMove; timer.black.rem=optPerMove;
    }
    updateTimerDisplay();
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
  function refreshTurn(){
    if(isSpectator){ setStatus('观战中'); return; }
    try{
      var t=(typeof turn!=='undefined')?turn:null;
      setStatus(t===myColor?'★ 轮到你走（'+(myColor==='r'?'红':'黑')+'）':'… 等待对方走棋');
    }catch(e){}
  }
  function setStatus(txt,persist){
    if(elStatus) elStatus.textContent=txt;
    clearTimeout(setStatus._t);
    if(!persist) setStatus._t=setTimeout(refreshTurn,4000);
  }
  function setPlayers(p){
    if(!elPlayers) return;
    elPlayers.textContent='红：'+(p.red||'空')+'　黑：'+(p.black||'空')+(p.spectators?('　观'+p.spectators):'');
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
  function showBanner(t){
    var d=document.createElement('div');
    d.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#9d2c21;color:#fff;display:flex;align-items:center;justify-content:center;font:16px serif;text-align:center;padding:20px';
    d.textContent=t; document.body.appendChild(d);
  }
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
})();
