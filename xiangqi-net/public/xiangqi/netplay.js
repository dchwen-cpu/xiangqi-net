/* 立山象棋 · 联网层 v3
 * 加到象棋 index.html 末尾：<script src="netplay.js"></script>
 * 仅当 URL 带 ?table=... 时激活；否则离线版行为不变。
 *
 * 联网模式下：
 *   - 完全替换原始 UI → 简化两栏界面（左棋盘 + 右聊天）
 *   - 只保留：悔棋请求、翻转棋盘、复盘
 *   - 服务器权威回合 + playerId 认人(sessionStorage) + 自动重同步
 */
(function(){
  var params = new URLSearchParams(location.search);
  var tableId = params.get('table');
  if (!tableId) return;                        // 非联网模式，完全不激活

  var seatWanted = params.get('seat') || 'auto';
  var myName    = decodeURIComponent(params.get('name') || '访客');

  // 每标签页独立身份（sessionStorage），同浏览器两标签测试不会互顶座位
  var PID = sessionStorage.getItem('lsz_pid');
  if (!PID){ PID='p'+Math.random().toString(36).slice(2)+Date.now().toString(36); sessionStorage.setItem('lsz_pid',PID); }

  var myColor=null, isSpectator=false, applyingRemote=false, appliedCount=0;
  window.__netMode = false;

  // ── 载入 socket.io ──────────────────────────────────────────────
  var sc = document.createElement('script');
  sc.src = '/socket.io/socket.io.js';
  sc.onload = init;
  sc.onerror = function(){ showBanner('无法加载对战组件，请检查服务器连接'); };
  document.head.appendChild(sc);

  // ── 主流程 ──────────────────────────────────────────────────────
  function init(){
    var socket = io();
    window.__netSocket = socket;

    socket.on('connect', function(){
      socket.emit('table:join',{ tableId:tableId, seat:seatWanted, name:myName, playerId:PID });
    });
    socket.on('table:state',  function(st){ onState(st, socket); });
    socket.on('move', function(m){
      if (!m || typeof m.idx!=='number') return;
      if      (m.idx === appliedCount){ applyRemote(m); appliedCount++; refreshTurn(); }
      else if (m.idx < appliedCount)  { /* 已应用，忽略 */ }
      else                             { socket.emit('sync:request'); }
    });
    socket.on('chat',         function(m){ addChat(m); });
    socket.on('table:players',function(p){ setPlayers(p); });
    socket.on('table:over',   function(o){ setStatus((o.reason||'对局结束'), true); });
    socket.on('disconnect',   function(){ setStatus('连接中断，重连中…'); });

    // 悔棋 / 求和 协商
    socket.on('undo:request', function(){ if(confirm('对方请求悔棋一手，是否同意？')) socket.emit('undo:accept'); else socket.emit('undo:reject'); });
    socket.on('undo:reject',  function(){ setStatus('对方拒绝了悔棋'); });
    socket.on('draw:request', function(){ if(confirm('对方提出和棋，是否同意？')) socket.emit('draw:accept'); else socket.emit('draw:reject'); });
    socket.on('draw:reject',  function(){ setStatus('对方拒绝了和棋'); });
  }

  // ── 进入联网模式 ─────────────────────────────────────────────────
  function onState(st, socket){
    var seat = st.seat;
    isSpectator = (seat==='spectate');
    myColor = seat==='red' ? 'r' : (seat==='black' ? 'b' : null);

    // 先跳过开场，等动画结束再重建界面
    skipIntro(function(){
      buildNetUI(socket);   // 重建简化界面（把 canvas 搬进去）

      // 禁止引擎出手
      window.__netMode = true;
      try { mode='ai'; aiSide=isSpectator?'x':(myColor==='r'?'b':'r'); } catch(e){}
      if (typeof triggerAI==='function' && !triggerAI.__net){
        var _t=triggerAI;
        window.triggerAI=function(){ if(window.__netMode)return; return _t.apply(this,arguments); };
        window.triggerAI.__net=true;
      }
      // 拦截 makeMove：联网广播 + 观战/非回合保护
      if (typeof makeMove==='function' && !makeMove.__net){
        var _m=makeMove;
        window.makeMove=function(fr,fc,tr,tc){
          if(window.__netMode && isSpectator && !applyingRemote) return;
          if(window.__netMode && !applyingRemote && myColor && turn!==myColor) return;
          var r=_m(fr,fc,tr,tc);
          if(window.__netMode && !applyingRemote){
            appliedCount++;
            socket.emit('move',{fr:fr,fc:fc,tr:tr,tc:tc});
            refreshTurn();
          }
          return r;
        };
        window.makeMove.__net=true;
      }

      // 回放历史着法追到当前局面
      try { if(typeof reset==='function') reset(); } catch(e){}
      applyingRemote=true; appliedCount=0;
      try { (st.moves||[]).forEach(function(m){ makeMove(m.fr,m.fc,m.tr,m.tc); appliedCount++; }); } catch(e){}
      applyingRemote=false;
      try { turn=st.turn||'r'; if(typeof draw==='function') draw(); } catch(e){}

      setPlayers(st.seats||{});
      refreshTurn();
    });
  }

  function applyRemote(m){
    applyingRemote=true;
    try { makeMove(m.fr,m.fc,m.tr,m.tc); } catch(e){}
    applyingRemote=false;
    try { if(typeof draw==='function') draw(); } catch(e){}
  }

  // ── 跳过开场界面 ─────────────────────────────────────────────────
  function skipIntro(onDone){
    function doSkip(){
      try {
        var btn=document.getElementById('intro-enter-btn');
        var scr=document.getElementById('intro-screen');
        if(btn){ btn.click(); }
        else if(scr){ scr.style.display='none'; }
      } catch(e){}
      setTimeout(function(){ if(typeof onDone==='function') onDone(); }, 650);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',doSkip);
    else doSkip();
  }

  // ── 构建全新简化 UI ──────────────────────────────────────────────
  var elStatus, elPlayers, elChatLog, elChatIn, elReviewBar;

  function buildNetUI(socket){
    // 1) 把 body 里除了 canvas/fx-canvas/audio 以外的内容全隐藏
    //    (不删，保留 JS 引用的 DOM 节点)
    document.body.childNodes.forEach(function(n){
      if(n.nodeType===1 && !['SCRIPT','STYLE','AUDIO','LINK'].includes(n.tagName)){
        var id=n.id||'';
        if(id==='net-shell' || id==='net-style') return;
        n.style.setProperty('display','none','important');
      }
    });

    // 2) 注入样式
    if(!document.getElementById('net-style')){
      var st=document.createElement('style'); st.id='net-style';
      st.textContent=[
        '*{box-sizing:border-box}',
        ':root{--paper:#ece3d0;--paper2:#e4dabf;--ink:#201d16;--ink2:#443c30;--faint:#8a8069;--line:#cabd9f;--seal:#9d2c21;',
        '  --kai:"Kaiti SC","STKaiti","KaiTi","楷体",serif;--song:"Songti SC","STSong","SimSun","宋体",serif}',
        '#net-shell{position:fixed;inset:0;display:flex;flex-direction:column;',
        '  background:var(--paper);font-family:var(--song);color:var(--ink2);z-index:99990}',
        '#net-top{display:flex;align-items:center;gap:10px;padding:8px 14px;',
        '  background:var(--seal);color:#f2e8d5;font-size:13px;flex-shrink:0}',
        '#net-top b{font-family:var(--kai);letter-spacing:.08em;font-size:1rem}',
        '#net-top #net-players{flex:1;font-size:12px;opacity:.9}',
        '#net-top #net-status{font-size:12px;background:rgba(0,0,0,.18);',
        '  padding:2px 10px;border-radius:10px;white-space:nowrap}',
        '#net-top a{color:#f2e8d5;text-decoration:none;font-size:12px;opacity:.85}',
        '#net-top a:hover{opacity:1}',
        '#net-body{display:flex;flex:1;overflow:hidden}',
        '#net-board{flex:0 0 auto;display:flex;flex-direction:column;',
        '  align-items:center;justify-content:center;padding:10px;background:var(--paper)}',
        '#net-side{display:flex;flex-direction:column;flex:1;min-width:0;',
        '  border-left:1px solid var(--line);background:var(--paper2)}',
        '#net-chat-log{flex:1;overflow-y:auto;padding:12px;font-size:13px;line-height:1.7}',
        '#net-chat-log .msg-name{font-weight:bold}',
        '#net-chat-log .msg-red{color:var(--seal)}',
        '#net-chat-log .msg-black{color:var(--ink)}',
        '#net-chat-log .msg-obs{color:var(--faint)}',
        '#net-chat-log .msg-sys{color:var(--faint);font-style:italic;font-size:12px}',
        '#net-chat-in{display:flex;border-top:1px solid var(--line);padding:8px;gap:6px;flex-shrink:0}',
        '#net-chat-in input{flex:1;border:1px solid var(--line);border-radius:4px;',
        '  padding:6px 10px;background:var(--paper);font-family:var(--song);font-size:13px;color:var(--ink2)}',
        '#net-chat-in input:focus{outline:none;border-color:var(--seal)}',
        '#net-chat-in button{background:var(--seal);color:#f2e8d5;border:0;border-radius:4px;',
        '  padding:6px 12px;cursor:pointer;font-family:var(--song);font-size:13px}',
        '#net-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;',
        '  border-top:1px solid var(--line);background:var(--paper2);flex-shrink:0}',
        '#net-bar button{background:var(--paper);border:1px solid var(--line);border-radius:5px;',
        '  padding:6px 12px;cursor:pointer;font-family:var(--song);font-size:13px;color:var(--ink2);',
        '  transition:.2s}',
        '#net-bar button:hover{border-color:var(--seal);color:var(--seal)}',
        '#net-bar button:disabled{opacity:.4;cursor:default}',
        '#net-bar .spacer{flex:1}',
        '#net-review-bar{display:flex;align-items:center;gap:6px;padding:0 10px 8px;',
        '  background:var(--paper2);font-size:13px;flex-shrink:0}',
        '#net-review-bar button{background:var(--paper);border:1px solid var(--line);',
        '  border-radius:4px;padding:4px 10px;cursor:pointer;font-family:var(--song);font-size:12px}',
        '#net-review-bar span{color:var(--faint);font-size:12px;flex:1;text-align:center}',
        // canvas 在 net-board 里自适应
        '#board,#fx-canvas{display:block!important;max-width:100%;max-height:100%;',
        '  touch-action:none}',
        // 移动端：竖向堆叠
        '@media(max-width:600px){#net-body{flex-direction:column}',
        '#net-side{border-left:0;border-top:1px solid var(--line);max-height:220px}}'
      ].join('');
      document.head.appendChild(st);
    }

    // 3) 搭新壳
    var shell=document.createElement('div'); shell.id='net-shell';
    shell.innerHTML=[
      '<div id="net-top">',
      '  <b>立山象棋室</b>',
      '  <span id="net-players">—</span>',
      '  <span id="net-status">连接中…</span>',
      '  <a href="../" id="net-exit">退出</a>',
      '</div>',
      '<div id="net-body">',
      '  <div id="net-board"></div>',  // canvas 将被移入这里
      '  <div id="net-side">',
      '    <div id="net-chat-log"></div>',
      '    <div id="net-chat-in">',
      '      <input id="net-msg" maxlength="200" placeholder="说点什么…">',
      '      <button id="net-send">发送</button>',
      '    </div>',
      '  </div>',
      '</div>',
      '<div id="net-bar">',
      '  <button id="nb-undo">悔棋请求</button>',
      '  <button id="nb-flip">↕ 翻转棋盘</button>',
      '  <button id="nb-review">🔍 复盘</button>',
      '  <div class="spacer"></div>',
      '  <button id="nb-resign">认输</button>',
      '</div>',
      '<div id="net-review-bar" style="display:none">',
      '  <button id="nb-rv-first">⏮</button>',
      '  <button id="nb-rv-prev">◀</button>',
      '  <span id="nb-rv-status"></span>',
      '  <button id="nb-rv-next">▶</button>',
      '  <button id="nb-rv-last">⏭</button>',
      '  <button id="nb-rv-exit">退出复盘</button>',
      '</div>'
    ].join('');
    document.body.appendChild(shell);

    // 4) 把原来的 canvas 搬进 #net-board
    var boardDiv=document.getElementById('net-board');
    var origCanvas=document.getElementById('board');
    var fxCanvas=document.getElementById('fx-canvas');
    if(origCanvas) boardDiv.appendChild(origCanvas);
    if(fxCanvas)   boardDiv.appendChild(fxCanvas);
    // 重算棋盘尺寸以适应新容器
    setTimeout(function(){ try{ if(typeof sizeCanvas==='function') sizeCanvas(true); if(typeof draw==='function') draw(); }catch(e){} }, 100);
    window.addEventListener('resize', function(){ try{ if(typeof sizeCanvas==='function') sizeCanvas(true); }catch(e){} });

    // 5) 绑定各按钮
    elStatus  = document.getElementById('net-status');
    elPlayers = document.getElementById('net-players');
    elChatLog = document.getElementById('net-chat-log');
    elChatIn  = document.getElementById('net-msg');
    elReviewBar = document.getElementById('net-review-bar');

    // 悔棋请求
    document.getElementById('nb-undo').onclick=function(){
      if(isSpectator){setStatus('观战者不能请求悔棋');return;}
      socket.emit('undo:request'); setStatus('已请求悔棋，等待对方同意…');
    };
    // 翻转（直接触发原来的翻转按钮逻辑）
    document.getElementById('nb-flip').onclick=function(){
      try{ document.getElementById('flip-btn').click(); }catch(e){
        try{ boardFlipped=!boardFlipped; if(typeof draw==='function')draw(); }catch(e2){}
      }
    };
    // 复盘（触发原复盘按钮）
    document.getElementById('nb-review').onclick=function(){
      try{ document.getElementById('review-btn').click(); }catch(e){}
      elReviewBar.style.display='flex';
    };
    // 复盘导航（镜像原来的复盘 chips）
    ['first','prev','next','last','exit'].forEach(function(k){
      var nb=document.getElementById('nb-rv-'+k);
      var ob=document.getElementById('review-'+k);
      if(nb && ob){ nb.onclick=function(){ ob.click();
        if(k==='exit'){ elReviewBar.style.display='none'; }
        try{ var rs=document.getElementById('review-status'); if(rs) document.getElementById('nb-rv-status').textContent=rs.textContent; }catch(e){}
      }; }
    });
    // 认输
    document.getElementById('nb-resign').onclick=function(){
      if(isSpectator)return;
      if(confirm('确认认输？')) socket.emit('resign');
    };
    // 退出确认
    document.getElementById('net-exit').onclick=function(e){
      if(!confirm('确认退出当前对局？')) e.preventDefault();
    };
    // 聊天
    function sendChat(){
      var v=(elChatIn.value||'').trim();
      if(v){ socket.emit('chat',{text:v}); elChatIn.value=''; }
    }
    document.getElementById('net-send').onclick=sendChat;
    elChatIn.addEventListener('keydown',function(e){ if(e.key==='Enter') sendChat(); });
  }

  // ── 工具函数 ─────────────────────────────────────────────────────
  function refreshTurn(){
    if(isSpectator){ setStatus('观战中'); return; }
    try{
      var myTurn=(typeof turn!=='undefined' && turn===myColor);
      setStatus(myTurn ? '★ 轮到你走（'+(myColor==='r'?'红':'黑')+'）' : '… 等待对方走棋');
    }catch(e){}
  }
  function setStatus(t, persist){
    if(elStatus) elStatus.textContent=t;
    if(!persist){ clearTimeout(setStatus._t); setStatus._t=setTimeout(refreshTurn,4000); }
  }
  function setPlayers(p){
    if(!elPlayers)return;
    elPlayers.textContent='红：'+(p.red||'空')+'　黑：'+(p.black||'空')+(p.spectators?('　观'+p.spectators):'');
  }
  function addChat(m){
    if(!elChatLog)return;
    var cls=m.seat==='red'?'msg-red':m.seat==='black'?'msg-black':m.name==='系统'?'msg-sys':'msg-obs';
    var who=m.seat==='red'?'红方':m.seat==='black'?'黑方':'观众';
    var d=document.createElement('div');
    if(m.name==='系统'){ d.className='msg-sys'; d.textContent='— '+m.text+' —'; }
    else{ d.innerHTML='<span class="msg-name '+cls+'">'+esc(m.name)+'</span>'
      +' <span style="color:var(--faint);font-size:11px">('+who+')</span>：'+esc(m.text); }
    elChatLog.appendChild(d); elChatLog.scrollTop=elChatLog.scrollHeight;
  }
  function showBanner(t){
    var d=document.createElement('div');
    d.style.cssText='position:fixed;left:0;right:0;top:0;z-index:999999;background:#9d2c21;color:#fff;padding:10px;text-align:center;font:14px serif';
    d.textContent=t; document.body.appendChild(d);
  }
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
})();
