/* 自毁 Service Worker
 * 上传到 public/xiangqi/sw.js 覆盖旧版。
 * 激活后：清空所有旧缓存 → 注销自身 → 自动刷新所有标签页
 * 之后浏览器访问始终直接从服务器取最新文件，永远不再需要强制刷新。
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // 清空所有旧缓存
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    // 注销自身
    await self.registration.unregister();
    // 接管所有标签页并自动刷新
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => { try { c.navigate(c.url); } catch(e) {} });
  })());
});

self.addEventListener('fetch', () => {}); // 不拦截任何请求，透传到服务器
