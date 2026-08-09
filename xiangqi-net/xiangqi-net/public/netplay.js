/* 立山象棋 · 联网层 v4
 * <script src="netplay.js"></script> 加到象棋 index.html 末尾。
 * 仅当 URL 带 ?table=... 时激活；否则离线版行为完全不变。
 *
 * v4 修复：
 *   - uiBuilt 标记：UI 只建一次，onState 第二次触发只重同步棋局
 *   - net-shell z-index 提到最大值，确保盖住原始顶栏和右侧菜单
 *   - 硬编码颜色，不依赖原始 app 的 CSS 变量
 *   - 服务器不再回显给发送者，走子不再退回
 */
(function(){
  // 肉眼可见的版本标记：页面右下角短暂显示，确认新版已加载
  (function(){
    var tag = document.createElement('div');
    tag.textContent = 'netplay v4 ✓';
    tag.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483647;'
      + 'background:#2d6a2d;color:#fff;padding:4px 10px;border-radius:4px;'
      + 'font:12px sans-serif;opacity:.9;pointer-events:none';
    document.addEventListener('DOMContentLoaded', function(){
      document.body.appendChild(tag);
      setTimeout(function(){ tag.style.display='none'; }, 4000);
    });
  })();
  var params = new URLSearchParams(location.search);
  var tableId = params.get('table');
  if (!tableId) return;

  // 联网模式下取消 Service Worker 并清除所有旧缓存。
  // SW 的离线缓存在这里只会阻止新版文件被加载，联网下棋不需要它。
  // 只影响在线棋室路径（带 ?table=），单机离线模式不受影响。
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function(regs){
        regs.forEach(function(r){ r.unregister(); });
      });
    }
    if ('caches' in window) {
      caches.keys().then(function(keys){
        keys.forEach(function(k){ caches.delete(k); });
      });
    }
  } catch(e) {}

  var seatWanted = decodeURIComponent(params.get('seat') || 'auto');
  var myName     = decodeURIComponent(params.get('name') || '访客');

  // 每标签页独立 PID（sessionStorage），同浏览器两个标签测试不会互顶座位
  var PID = sessionStorage.getItem('lsz_pid');
  if (!PID){ PID='p'+Math.random().toString(36).slice(2)+Date.now().toString(36); sessionStorage.setItem('lsz_pid',PID); }

  var myColor=null, isSpectator=false;
  var applyingRemote=false, appliedCount=0;
  var uiBuilt=false, hooksSet=false;
  window.__netMode = false;

  // ── 载入 socket.io ──
  var sc=document.createElement('script'); sc.src='/socket.io/socket.io.js';
  sc.onload=init;
  sc.onerror=function(){ showBanner('无法加载对战组件，请检查服务器连接'); };
  document.head.appendChild(sc);

  function init(){
    var socket=io();
    window.__netSocket=socket;

    socket.on('connect', function(){
      socket.emit('table:join',{tableId:tableId,seat:seatWanted,name:myName,playerId:PID});
    });
    // table:state：首次→建 UI + 设钩子；之后→只重同步棋局
    socket.on('table:state', function(st){
      myColor     = st.seat==='red' ? 'r' : (st.seat==='black' ? 'b' : null);
      isSpectator = (st.seat==='spectate');
      if (!uiBuilt){
        skipIntro(function(){
          buildNetUI(socket);
          uiBuilt = true;
          setupHooks(socket);
          doSync(st);
        });
      } else {
        doSync(st);
      }
    });
    // 收到对方着法（服务器已不回显给发送者，这里只处理对方的）
    socket.on('move', function(m){
      if (!m || typeof m.idx!=='number') return;
      if      (m.idx===appliedCount){ applyRemote(m); appliedCount++; refreshTurn(); }
      else if (m.idx < appliedCount){ /* 已应用，忽略 */ }
      else    { socket.emit('sync:request'); }
    });
    socket.on('chat',          function(m){ addChat(m); });
    socket.on('table:players', function(p){ setPlayers(p); });
    socket.on('table:over',    function(o){ setStatus((o.reason||'对局结束'), true); });
    socket.on('disconnect',    function(){ setStatus('连接中断，重连中…'); });

    // 悔棋 / 求和 协商
    socket.on('undo:request', function(){
      if(confirm('对方请求悔棋一手，是否同意？')) socket.emit('undo:accept');
      else socket.emit('undo:reject');
    });
    socket.on('undo:reject',  function(){ setStatus('对方拒绝了悔棋'); });
    socket.on('draw:request', function(){
      if(confirm('对方提出和棋，是否同意？')) socket.emit('draw:accept');
      else socket.emit('draw:reject');
    });
    socket.on('draw:reject',  function(){ setStatus('对方拒绝了和棋'); });
  }

  // ── 设置钩子（只执行一次）──
  function setupHooks(socket){
    if (hooksSet) return;
    hooksSet = true;
    window.__netMode = true;
    try { mode='ai'; aiSide=isSpectator?'x':(myColor==='r'?'b':'r'); } catch(e){}

    // 禁止引擎出手
    if (typeof triggerAI==='function' && !triggerAI.__net){
      var _t=triggerAI;
      window.triggerAI=function(){ if(window.__netMode)return; return _t.apply(this,arguments); };
      window.triggerAI.__net=true;
    }
    // 拦截走子
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

  // ── 同步棋局到服务器状态（reset + 回放）──
  function doSync(st){
    applyingRemote=true; appliedCount=0;
    try { if(typeof reset==='function') reset(); } catch(e){}
    try { (st.moves||[]).forEach(function(m){ makeMove(m.fr,m.fc,m.tr,m.tc); appliedCount++; }); } catch(e){}
    applyingRemote=false;
    try { turn=st.turn||'r'; if(typeof draw==='function') draw(); } catch(e){}
    try {
      // 棋盘翻转：黑方默认翻转
      if (!isSpectator && myColor==='b' && typeof boardFlipped!=='undefined' && !boardFlipped){
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

  // ── 跳过开场界面 ──
  function skipIntro(onDone){
    function doSkip(){
      try {
        var btn=document.getElementById('intro-enter-btn');
        var scr=document.getElementById('intro-screen');
        if(btn) btn.click();
        else if(scr) scr.style.display='none';
      } catch(e){}
      setTimeout(function(){ if(typeof onDone==='function') onDone(); }, 680);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',doSkip);
    else doSkip();
  }

  // ── 构建简化 UI（只执行一次）──
  var elStatus, elPlayers, elChatLog, elChatIn;

  function buildNetUI(socket){
    console.log('[netplay v4] buildNetUI called');
    // 注入样式（硬编码颜色，不依赖原始 app 的 CSS 变量）
    var st=document.createElement('style'); st.id='net-style';
    st.textContent=[
      // 重置 body
      'body{overflow:hidden!important;margin:0!important;padding:0!important}',
      // 全屏壳：z-index 最高，确保盖住原始顶栏和右侧面板
      '#net-shell{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;',
        'background:#ece3d0;font-family:"Songti SC","STSong","SimSun","宋体",serif;color:#443c30}',
      // 顶栏
      '#net-top{display:flex;align-items:center;gap:10px;padding:7px 14px;',
        'background:#9d2c21;color:#f2e8d5;font-size:13px;flex-shrink:0;min-height:36px}',
      '#net-top b{font-family:"Kaiti SC","STKaiti","KaiTi","楷体",serif;',
        'font-size:1rem;letter-spacing:.1em}',
      '#net-players{flex:1;font-size:12px;opacity:.9}',
      '#net-status{font-size:12px;background:rgba(0,0,0,.2);padding:2px 10px;',
        'border-radius:10px;white-space:nowrap}',
      '#net-top a{color:#f2e8d5;text-decoration:none;font-size:12px;opacity:.85;',
        'padding:2px 8px;border:1px solid rgba(242,232,213,.4);border-radius:4px}',
      '#net-top a:hover{opacity:1;background:rgba(0,0,0,.15)}',
      // 主体：左棋盘 + 右聊天
      '#net-body{display:flex;flex:1;overflow:hidden;min-height:0}',
      '#net-board{flex:0 0 auto;display:flex;align-items:center;justify-content:center;',
        'background:#ece3d0;padding:8px;overflow:hidden}',
      // 右侧聊天面板覆盖原始菜单区
      '#net-side{display:flex;flex-direction:column;flex:1;min-width:200px;',
        'background:#e4dabf;border-left:1px solid #cabd9f}',
      '#net-side-hd{padding:8px 12px;border-bottom:1px solid #cabd9f;',
        'font-family:"Kaiti SC","STKaiti","KaiTi","楷体",serif;',
        'font-size:1rem;color:#201d16;letter-spacing:.1em;flex-shrink:0}',
      '#net-chat-log{flex:1;overflow-y:auto;padding:10px 12px;',
        'font-size:13px;line-height:1.75;min-height:0}',
      '.nc-red{color:#9d2c21;font-weight:bold}',
      '.nc-blk{color:#201d16;font-weight:bold}',
      '.nc-obs{color:#8a8069;font-weight:bold}',
      '.nc-sys{color:#8a8069;font-style:italic;font-size:12px;text-align:center;padding:2px 0}',
      '#net-chat-in{display:flex;border-top:1px solid #cabd9f;padding:7px 8px;',
        'gap:6px;flex-shrink:0;background:#e4dabf}',
      '#net-chat-in input{flex:1;border:1px solid #cabd9f;border-radius:4px;',
        'padding:6px 9px;background:#ece3d0;font-family:"Songti SC","SimSun",serif;',
        'font-size:13px;color:#201d16;outline:none}',
      '#net-chat-in input:focus{border-color:#9d2c21}',
      '#net-send{background:#9d2c21;color:#f2e8d5;border:0;border-radius:4px;',
        'padding:6px 12px;cursor:pointer;font-family:"Songti SC","SimSun",serif;font-size:13px}',
      // 底部控制栏
      '#net-bar{display:flex;align-items:center;gap:8px;padding:7px 10px;',
        'border-top:1px solid #cabd9f;background:#e4dabf;flex-shrink:0}',
      '#net-bar button{background:#ece3d0;border:1px solid #cabd9f;border-radius:5px;',
        'padding:5px 12px;cursor:pointer;font-family:"Songti SC","SimSun",serif;',
        'font-size:13px;color:#443c30;transition:.2s}',
      '#net-bar button:hover{border-color:#9d2c21;color:#9d2c21}',
      '#net-bar .spacer{flex:1}',
      '#nb-resign{color:#9d2c21!important;border-color:#9d2c21!important}',
      '#nb-resign:hover{background:#9d2c21!important;color:#f2e8d5!important}',
      // 复盘导航条
      '#net-rv-bar{display:none;align-items:center;gap:6px;padding:5px 10px;',
        'border-top:1px solid #cabd9f;background:#ece3d0;flex-shrink:0}',
      '#net-rv-bar button{background:#ece3d0;border:1px solid #cabd9f;border-radius:4px;',
        'padding:4px 9px;cursor:pointer;font-size:12px;font-family:"Songti SC","SimSun",serif}',
      '#net-rv-bar span{flex:1;text-align:center;font-size:12px;color:#8a8069}',
      // canvas 自适应容器
      '#board,#fx-canvas{display:block!important;max-width:100%!important;',
        'max-height:100%!important;touch-action:none!important}',
      // 手机：竖屏堆叠
      '@media(max-width:580px){#net-body{flex-direction:column}',
        '#net-side{min-width:0;max-height:200px;border-left:0;border-top:1px solid #cabd9f}}'
    ].join('');
    document.head.appendChild(st);

    // 搭壳
    var shell=document.createElement('div'); shell.id='net-shell';
    shell.innerHTML=[
      '<div id="net-top">',
        '<b>立山象棋室</b>',
        '<span id="net-players">—</span>',
        '<span id="net-status">连接中…</span>',
        '<a href="../" id="net-exit">退出</a>',
      '</div>',
      '<div id="net-body">',
        '<div id="net-board"></div>',
        '<div id="net-side">',
          '<div id="net-side-hd">对局聊天</div>',
          '<div id="net-chat-log"></div>',
          '<div id="net-chat-in">',
            '<input id="net-msg" maxlength="200" placeholder="说点什么…" autocomplete="off">',
            '<button id="net-send">发</button>',
          '</div>',
        '</div>',
      '</div>',
      '<div id="net-bar">',
        '<button id="nb-undo">悔棋请求</button>',
        '<button id="nb-flip">↕ 翻转棋盘</button>',
        '<button id="nb-review">🔍 复盘</button>',
        '<div class="spacer"></div>',
        '<button id="nb-resign">认输</button>',
      '</div>',
      '<div id="net-rv-bar">',
        '<button id="nb-rv-first">⏮</button>',
        '<button id="nb-rv-prev">◀</button>',
        '<span id="nb-rv-st"></span>',
        '<button id="nb-rv-next">▶</button>',
        '<button id="nb-rv-last">⏭</button>',
        '<button id="nb-rv-exit">退出复盘</button>',
      '</div>'
    ].join('');
    document.body.appendChild(shell);

    // 把 canvas 搬进 #net-board
    var boardDiv=document.getElementById('net-board');
    var cv=document.getElementById('board');
    var fx=document.getElementById('fx-canvas');
    if(cv) boardDiv.appendChild(cv);
    if(fx) boardDiv.appendChild(fx);
    // 重算棋盘尺寸
    setTimeout(function(){
      try{ if(typeof sizeCanvas==='function') sizeCanvas(true); if(typeof draw==='function') draw(); }catch(e){}
    },100);
    window.addEventListener('resize',function(){
      try{ if(typeof sizeCanvas==='function') sizeCanvas(true); }catch(e){}
    });

    // 绑定控件
    elStatus   = document.getElementById('net-status');
    elPlayers  = document.getElementById('net-players');
    elChatLog  = document.getElementById('net-chat-log');
    elChatIn   = document.getElementById('net-msg');
    var rvBar  = document.getElementById('net-rv-bar');

    // 悔棋请求
    document.getElementById('nb-undo').onclick=function(){
      if(isSpectator){setStatus('观战者不能请求悔棋');return;}
      socket.emit('undo:request'); setStatus('已请求悔棋，等待对方同意…');
    };
    // 翻转棋盘（直接操作全局变量，不依赖隐藏按钮）
    document.getElementById('nb-flip').onclick=function(){
      try{ boardFlipped=!boardFlipped; if(typeof draw==='function')draw(); }catch(e){}
    };
    // 复盘（点隐藏的原始复盘按钮，再显示导航条）
    document.getElementById('nb-review').onclick=function(){
      try{ document.getElementById('review-btn').click(); }catch(e){}
      rvBar.style.display='flex';
    };
    // 复盘导航
    ['first','prev','next','last'].forEach(function(k){
      var nb=document.getElementById('nb-rv-'+k);
      var ob=document.getElementById('review-'+k);
      if(nb && ob){ nb.onclick=function(){
        ob.click();
        try{ var rs=document.getElementById('review-status'); if(rs) document.getElementById('nb-rv-st').textContent=rs.textContent; }catch(e){}
      }; }
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
      if(!confirm('确认退出当前对局？')){ e.preventDefault(); }
    };
    // 聊天
    function sendChat(){
      var v=(elChatIn.value||'').trim();
      if(v){ socket.emit('chat',{text:v}); elChatIn.value=''; }
    }
    document.getElementById('net-send').onclick=sendChat;
    elChatIn.addEventListener('keydown',function(e){ if(e.key==='Enter')sendChat(); });
  }

  // ── 工具 ──
  function refreshTurn(){
    if(isSpectator){ setStatus('观战中'); return; }
    try{
      var t = (typeof turn!=='undefined') ? turn : null;
      setStatus(t===myColor ? '★ 轮到你走（'+(myColor==='r'?'红':'黑')+'）'
                            : '… 等待对方走棋');
    }catch(e){}
  }
  function setStatus(txt, persist){
    if(elStatus) elStatus.textContent=txt;
    clearTimeout(setStatus._t);
    if(!persist) setStatus._t=setTimeout(refreshTurn,4000);
  }
  function setPlayers(p){
    if(!elPlayers)return;
    var obs = p.spectators ? ('　观'+p.spectators) : '';
    elPlayers.textContent='红：'+(p.red||'空')+'　黑：'+(p.black||'空')+obs;
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
    d.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#9d2c21;color:#fff;display:flex;align-items:center;justify-content:center;font:16px serif;text-align:center;padding:20px';
    d.textContent=t; document.body.appendChild(d);
  }
  function esc(s){
    return String(s).replace(/[&<>"]/g,function(c){
      return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
    });
  }
})();
