const CACHE = 'xiangqi-v11';

// 首屏必需：安装时就下好，保证断网也能开局（约 1.1 MB）
const CORE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192-v3.png',
  './icon-512-v3.png',
  './icon-maskable-512-v3.png',
  './apple-touch-icon-180-v3.png'
];

// 体积大且非首屏必需：不预下载，首次用到时再缓存
// （引擎 1.6 MB 只在棋力≥业余级或残局时才需要；背景音乐 2 MB 纯装饰）
// 这样首次打开只需 ~1.1 MB，慢速网络下体感差别很大
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // 单个资源失败不连累整体安装（例如音频临时取不到）
      .then(c => Promise.allSettled(CORE.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 页面导航：离线时回落到缓存的首页
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // 其余资源：缓存优先，取到新的就顺手存起来
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      // 放宽条件：只要是本站的成功响应就存起来。
      // 原来限定 type==='basic'，Worker 里取 .wasm 时类型不一定匹配，
      // 会导致 1.6MB 的引擎始终进不了缓存、离线时只能靠浏览器HTTP缓存碰运气。
      const sameOrigin = (function(){ try { return new URL(req.url).origin === self.location.origin; } catch(e){ return false; } })();
      if (res && res.ok && sameOrigin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
