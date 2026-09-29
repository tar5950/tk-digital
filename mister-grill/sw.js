/* Mister Grill — cache hors-ligne. Incrémenter VERSION après chaque mise à jour du menu. */
const VERSION = 'mg-v3';
const CORE = ['./', 'index.html', 'menu.js', 'manifest.webmanifest', 'img/logo.png', 'img/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Pages & menu : réseau d'abord (prix toujours à jour), cache en secours
  if (req.mode === 'navigate' || url.pathname.endsWith('menu.js')) {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c)); return r; }).catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
    return;
  }
  // Images, polices : cache d'abord
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok && (url.origin === location.origin || url.host.includes('gstatic') || url.host.includes('googleapis'))) {
      const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c));
    }
    return r;
  })));
});
