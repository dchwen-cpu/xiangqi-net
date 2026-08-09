/* 立山象棋 · 联网层 v5
 * 加到 index.html 末尾：<script src="netplay.js"></script>
 * 仅当 URL 带 ?table=... 时激活；否则离线版行为完全不变。
 *
 * v5 关键改动：
 *   - 不再移动 canvas，改用固定叠加层覆盖在原始界面上
 *     → sizeCanvas/handleTap 坐标完全正常，走子不再失效
 *   - 用 CSS 隐藏原始 AI 控件（棋力/模式/残局/评测/重新开始等）
 *   - 右侧固定聊天面板覆盖原始设置区
 *   - sessionStorage PID：同浏览器两个标签可分别入座
 */
(function(){
  var params  = new URLSearchParams(location.search);
  var tableId = params.get('table');
  if (!tableId) return;

  var seatWanted = decodeURIComponent(params.get('seat') || 'auto');
  var myName     = decodeURIComponent(params.get('name') || '访客');

  // 每标签独立 PID
  var PID = sessionStorage.getItem('lsz_pid');
  if (!PID){ PID='p'+Math.random().toString(36).slice(2)+Date.now().toString(36); sessionStorage.setItem('lsz_pid',PID); }

  var myColor=null, isSpectator=false;
  var applyingRemote=false, appliedCount=0;
  var uiBuilt=false, hooksSet=false;
  window.__netMode = false;

  // ── 加载 socket.io ──────────────────────────────────────────
  var sc=document.createElement('script'); sc.src='/socket.io/socket.io.js';
  sc.onload=init;
  sc.onerror=function(){ showBanner('无法连接象棋室服务器'); };
  document.head.appendChild(sc);

  function init(){
    var socket=io();
    window.__netSocket=socket;

    socket.on('connect', function(){
      socket.emit('table:join',{tableId:tableId,seat:seatWanted,name:myName,playerId:PID});
    });
    socket.on('table:state', function(st){
      myColor     = st.seat==='red'?'r':(st.seat==='black'?'b':null);
      isSpectator = (st.seat==='spectate');
      if (!uiBuilt){
        skipIntro(function(){
          buildNetUI(socket);
          uiBuilt=true;
          setupHooks(socket);
          doSync(st);
        });
      } else {
        doSync(st);
      }
    });
    socket.on('move', function(m){
      if (!m||typeof m.idx!=='number') return;
      if      (m.idx===appliedCount){ applyRemote(m); appliedCount++; refreshTurn(); }
      else if (m.idx < appliedCount){ /* 已应用，忽略 */ }
      else    { socket.emit('sync:request'); }
    });
    socket.on('chat',          function(m){ addChat(m); });
    socket.on('table:players', function(p){ setPlayers(p); });
    socket.on('table:over',    function(o){ setStatus(o.reason||'对局结束', true); });
    socket.on('disconnect',    function(){ setStatus('连接中断，重连中…'); });
    socket.on('undo:request',  function(){ if(confirm('对方请求悔棋，是否同意？')) socket.emit('undo:accept'); else socket.emit('undo:reject'); });
    socket.on('undo:reject',   function(){ setStatus('对方拒绝了悔棋'); });
    socket.on('draw:request',  function(){ if(confirm('对方提出和棋，是否同意？')) socket.emit('draw:accept'); else socket.emit('draw:reject'); });
    socket.on('draw:reject',   function(){ setStatus('对方拒绝了和棋'); });
  }

  // ── 钩子（只设一次）────────────────────────────────────────
  function setupHooks(socket){
    if (hooksSet) return; hooksSet=true;
    window.__netMode=true;
    try { mode='ai'; aiSide=isSpectator?'x':(myColor==='r'?'b':'r'); } catch(e){}
    if (typeof triggerAI==='function' && !triggerAI.__net){
      var _t=triggerAI;
      window.triggerAI=function(){ if(window.__netMode)return; return _t.apply(this,arguments); };
      window.triggerAI.__net=true;
    }
    if (typeof makeMove==='function' && !makeMove.__net){
      var _m=makeMove;
      window.makeMove=function(fr,fc,tr,tc){
        if(window.__netMode && isSpectator && !applyingRemote) return;
        if(window.__netMode && !applyingRemote && myColor && typeof turn!=='undefined' && turn!==myColor) return;
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
  }

  // ── 同步棋局 ────────────────────────────────────────────────
  function doSync(st){
    applyingRemote=true; appliedCount=0;
    try { if(typeof reset==='function') reset(); } catch(e){}
    try { (st.moves||[]).forEach(function(m){ makeMove(m.fr,m.fc,m.tr,m.tc); appliedCount++; }); } catch(e){}
    applyingRemote=false;
    try { turn=st.turn||'r'; if(typeof draw==='function') draw(); } catch(e){}
    try {
      if(!isSpectator && myColor==='b' && typeof boardFlipped!=='undefined' && !boardFlipped){
        boardFlipped=true; if(typeof draw==='function') draw();
      }
    } catch(e){}
    setPlayers(st.seats||{});
    refreshTurn();
  }

  function applyRemote(m){
    applyingRemote=true;
    try { makeMove(m.fr,m.fc,m.tr,m.tc); } catch(e){}
    applyingRemote=false;
    try { if(typeof draw==='function') draw(); } catch(e){}
  }

  // ── 跳过开场 ────────────────────────────────────────────────
  function skipIntro(onDone){
    function doSkip(){
      try {
        var btn=document.getElementById('intro-enter-btn');
        var scr=document.getElementById('intro-screen');
        if(btn) btn.click(); else if(scr) scr.style.display='none';
      } catch(e){}
      setTimeout(function(){ if(typeof onDone==='function') onDone(); }, 680);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',doSkip);
    else doSkip();
  }

  // ── 构建叠加 UI（canvas 不动，固定叠加层覆盖原始界面）──────
  var elStatus, elPlayers, elChatLog, elChatIn;

  function buildNetUI(socket){
    // 1) 注入 CSS
    var st=document.createElement('style'); st.id='net-style';
    st.textContent=[
      // 隐藏 AI 相关控件（棋力/模式/残局/评测/重来/求和/提示等）
      '#trig-level,#trig-redlevel,#trig-blacklevel,#trig-mode,',
      '#mtrig-level,#mtrig-mode,#endgame-btn,#assess-btn,#restart,',
      '#draw-btn,#hint-btn,#undo,#mm-btn,',
      '.setting-trigger[data-target="overlay-content-level"],',
      '.setting-trigger[data-target="overlay-content-mode"]',
      '{display:none!important}',

      // 顶部留出空间给我们的状态栏
      'body{padding-top:40px!important;box-sizing:border-box}',

      // 状态栏
      '#net-top{position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483647;',
        'display:flex;align-items:center;gap:10px;padding:0 14px;',
        'background:#9d2c21;color:#f2e8d5;',
        'font:13px "Songti SC","STSong","SimSun",serif}',
      '#net-top b{font-family:"Kaiti SC","STKaiti","KaiTi","楷体",serif;',
        'font-size:1rem;letter-spacing:.1em}',
      '#net-players{flex:1;font-size:12px;opacity:.9}',
      '#net-status{font-size:12px;background:rgba(0,0,0,.22);',
        'padding:2px 10px;border-radius:10px;white-space:nowrap}',
      '#net-top a{color:#f2e8d5;text-decoration:none;font-size:12px;opacity:.8;',
        'padding:2px 8px;border:1px solid rgba(255,255,255,.3);border-radius:4px}',
      '#net-top a:hover{opacity:1}',

      // 右侧聊天面板（固定在右边，覆盖原始设置区）
      '#net-side{position:fixed;top:40px;right:0;bottom:50px;width:244px;',
        'z-index:2147483646;display:flex;flex-direction:column;',
        'background:#e4dabf;border-left:1px solid #cabd9f;',
        'font:13px "Songti SC","STSong","SimSun",serif}',
      '#net-side-hd{flex-shrink:0;padding:8px 12px;border-bottom:1px solid #cabd9f;',
        'font-family:"Kaiti SC","STKaiti","楷体",serif;',
        'font-size:.95rem;color:#201d16;letter-spacing:.08em}',
      '#net-chat-log{flex:1;overflow-y:auto;padding:10px 12px;',
        'font-size:13px;line-height:1.75;color:#443c30;min-height:0}',
      '.nc-red{color:#9d2c21;font-weight:bold}',
      '.nc-blk{color:#201d16;font-weight:bold}',
      '.nc-obs{color:#8a8069;font-weight:bold}',
      '.nc-sys{color:#8a8069;font-style:italic;font-size:12px;text-align:center;padding:2px 0}',
      '#net-chat-in{flex-shrink:0;display:flex;border-top:1px solid #cabd9f;',
        'padding:7px 8px;gap:6px;background:#e4dabf}',
      '#net-chat-in input{flex:1;border:1px solid #cabd9f;border-radius:4px;',
        'padding:6px 8px;background:#ece3d0;outline:none;',
        'font:13px "Songti SC","SimSun",serif;color:#201d16}',
      '#net-chat-in input:focus{border-color:#9d2c21}',
      '#net-send{background:#9d2c21;color:#f2e8d5;border:0;border-radius:4px;',
        'padding:6px 11px;cursor:pointer;font:13px "Songti SC","SimSun",serif}',

      // 底部控制栏
      '#net-bar{position:fixed;bottom:0;left:0;right:0;height:50px;',
        'z-index:2147483647;display:flex;align-items:center;gap:8px;',
        'padding:0 10px;background:#e4dabf;border-top:1px solid #cabd9f;',
        'font:13px "Songti SC","STSong","SimSun",serif}',
      '#net-bar button{background:#ece3d0;border:1px solid #cabd9f;border-radius:5px;',
        'padding:6px 12px;cursor:pointer;color:#443c30;transition:.2s;',
        'font:13px "Songti SC","SimSun",serif}',
      '#net-bar button:hover{border-color:#9d2c21;color:#9d2c21}',
      '#net-bar .sp{flex:1}',
      '#nb-resign{color:#9d2c21!important;border-color:#c0392b!important}',
      '#nb-resign:hover{background:#9d2c21!important;color:#f2e8d5!important}',

      // 复盘导航条（默认隐藏）
      '#net-rv-bar{position:fixed;bottom:50px;left:0;right:0;',
        'z-index:2147483647;display:none;align-items:center;gap:6px;',
        'padding:5px 10px;background:#ece3d0;border-top:1px solid #cabd9f;',
        'font:12px "Songti SC","SimSun",serif}',
      '#net-rv-bar button{background:#ece3d0;border:1px solid #cabd9f;',
        'border-radius:4px;padding:4px 9px;cursor:pointer}',
      '#net-rv-bar span{flex:1;text-align:center;color:#8a8069}',

      // 手机：聊天面板改为底部
      '@media(max-width:580px){',
        '#net-side{top:auto;bottom:130px;left:0;right:0;width:auto;',
          'height:160px;border-left:0;border-top:1px solid #cabd9f}',
        '#net-bar{bottom:160px}',
        'body{padding-top:40px!important;padding-bottom:310px!important}',
      '}'
    ].join('');
    document.head.appendChild(st);

    // 2) 搭叠加层（直接插入 body，不动原有内容）
    var top=document.createElement('div'); top.id='net-top';
    top.innerHTML='<b>立山象棋室</b>'
      +'<span id="net-players">—</span>'
      +'<span id="net-status">连接中…</span>'
      +'<a href="../" id="net-exit">退出</a>';

    var side=document.createElement('div'); side.id='net-side';
    side.innerHTML='<div id="net-side-hd">对局聊天</div>'
      +'<div id="net-chat-log"></div>'
      +'<div id="net-chat-in">'
        +'<input id="net-msg" maxlength="200" placeholder="说点什么…" autocomplete="off">'
        +'<button id="net-send">发</button>'
      +'</div>';

    var bar=document.createElement('div'); bar.id='net-bar';
    bar.innerHTML='<button id="nb-undo">悔棋请求</button>'
      +'<button id="nb-flip">↕ 翻转</button>'
      +'<button id="nb-review">🔍 复盘</button>'
      +'<div class="sp"></div>'
      +'<button id="nb-resign">认输</button>';

    var rvBar=document.createElement('div'); rvBar.id='net-rv-bar';
    rvBar.innerHTML='<button id="nb-rv-first">⏮</button>'
      +'<button id="nb-rv-prev">◀</button>'
      +'<span id="nb-rv-st"></span>'
      +'<button id="nb-rv-next">▶</button>'
      +'<button id="nb-rv-last">⏭</button>'
      +'<button id="nb-rv-exit">退出复盘</button>';

    document.body.appendChild(top);
    document.body.appendChild(side);
    document.body.appendChild(bar);
    document.body.appendChild(rvBar);

    // 3) 绑定引用
    elStatus  =document.getElementById('net-status');
    elPlayers =document.getElementById('net-players');
    elChatLog =document.getElementById('net-chat-log');
    elChatIn  =document.getElementById('net-msg');

    // 悔棋请求
    document.getElementById('nb-undo').onclick=function(){
      if(isSpectator){setStatus('观战者不能请求悔棋');return;}
      socket.emit('undo:request'); setStatus('已请求悔棋，等待对方同意…');
    };
    // 翻转（直接操作全局变量）
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
      if(confirm('确认认输？')) socket.emit('resign');
    };
    // 退出
    document.getElementById('net-exit').onclick=function(e){
      if(!confirm('确认退出当前对局？')) e.preventDefault();
    };
    // 聊天
    function sendChat(){
      var v=(elChatIn.value||'').trim();
      if(v){ socket.emit('chat',{text:v}); elChatIn.value=''; }
    }
    document.getElementById('net-send').onclick=sendChat;
    elChatIn.addEventListener('keydown',function(e){ if(e.key==='Enter')sendChat(); });

    // 4) 通知版本（肉眼可见，4秒消失）
    var tag=document.createElement('div');
    tag.textContent='netplay v5 ✓';
    tag.style.cssText='position:fixed;left:10px;bottom:58px;z-index:2147483647;'
      +'background:#2d6a2d;color:#fff;padding:3px 9px;border-radius:4px;'
      +'font:11px sans-serif;pointer-events:none;opacity:.9';
    document.body.appendChild(tag);
    setTimeout(function(){ tag.style.display='none'; }, 4000);
  }

  // ── 工具 ────────────────────────────────────────────────────
  function refreshTurn(){
    if(isSpectator){ setStatus('观战中'); return; }
    try{
      var t=(typeof turn!=='undefined')?turn:null;
      setStatus(t===myColor
        ? '★ 轮到你走（'+(myColor==='r'?'红':'黑')+'）'
        : '… 等待对方走棋');
    }catch(e){}
  }
  function setStatus(txt,persist){
    if(elStatus) elStatus.textContent=txt;
    clearTimeout(setStatus._t);
    if(!persist) setStatus._t=setTimeout(refreshTurn,4000);
  }
  function setPlayers(p){
    if(!elPlayers)return;
    elPlayers.textContent='红：'+(p.red||'空')+'　黑：'+(p.black||'空')
      +(p.spectators?('　观'+p.spectators):'');
  }
  function addChat(m){
    if(!elChatLog)return;
    var d=document.createElement('div');
    if(m.name==='系统'){
      d.className='nc-sys'; d.textContent='—— '+m.text+' ——';
    } else {
      var cls=m.seat==='red'?'nc-red':m.seat==='black'?'nc-blk':'nc-obs';
      var who=m.seat==='red'?'红':m.seat==='black'?'黑':'观';
      d.innerHTML='<span class="'+cls+'">'+esc(m.name)+'</span>'
        +' <span style="color:#cabd9f;font-size:11px">('+who+')</span>：'+esc(m.text);
    }
    elChatLog.appendChild(d);
    elChatLog.scrollTop=elChatLog.scrollHeight;
  }
  function showBanner(t){
    var d=document.createElement('div');
    d.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#9d2c21;'
      +'color:#fff;display:flex;align-items:center;justify-content:center;'
      +'font:16px serif;text-align:center;padding:20px';
    d.textContent=t; document.body.appendChild(d);
  }
  function esc(s){
    return String(s).replace(/[&<>"]/g,function(c){
      return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }
})();
