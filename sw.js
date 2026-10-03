/* Cellar Book service worker: lets the app open offline. Same-origin files are fetched fresh
   when online (so updates show up right away) and served from the cache when offline. */
const CACHE = 'cellar-book-v2.0.1';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'js/core.js', 'js/sync.js', 'js/claude.js', 'js/app.js', 'js/features.js',
  'lib/leaflet.js', 'lib/leaflet.css', 'lib/exifr.js', 'icons/icon-192.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) {
    if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
      e.respondWith(caches.open(CACHE).then(async c => (await c.match(req)) || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })));
    }
    return; // Claude, Dropbox, map tiles and place names always go to the network
  }
  e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })
    .catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
});
