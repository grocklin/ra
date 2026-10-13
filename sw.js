// Ra — offline support. Every file the game needs is cached on first visit, so a game in progress
// keeps working (and the page can even be reloaded) without a connection.
// Code and pages: network first, cache as fallback (updates arrive as soon as you're online).
// Tile images: cache first (they never change).
const CACHE = 'ra-2.0-v11';
const V = '?v=11';
const FILES = ['./', 'index.html', 'style.css' + V, 'weights.js' + V, 'ra_engine.js' + V, 'ai_improved.js' + V, 'game.js' + V, 'app.js' + V, 'img/icon.png']
  .concat(Array.from({ length: 23 }, (_, i) => `img/big${i}.png`));
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (/\/img\//.test(req.url)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const c = res.clone(); caches.open(CACHE).then(k => k.put(req, c)); return res; })));
    return;
  }
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const c = res.clone(); caches.open(CACHE).then(k => k.put(req, c)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(r => r || caches.match('index.html'))));
});
