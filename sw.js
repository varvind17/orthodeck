// OrthoDeck service worker. Bump CACHE_VERSION whenever you change app files
// so installed phones pick up the update on next launch.
const CACHE_VERSION = 'orthodeck-v8';
const IMAGE_CACHE = 'orthodeck-images';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './db.js',
  './cards.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== IMAGE_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Cross-origin images (card pictures found via web search): cache-first, opaque responses allowed.
  if (url.origin !== self.location.origin) {
    if (event.request.destination === 'image') {
      event.respondWith(
        caches.open(IMAGE_CACHE).then((c) => c.match(event.request.url).then((hit) => hit || fetch(event.request.url, { mode: 'no-cors' }).then((r) => { c.put(event.request.url, r.clone()); return r; })))
      );
    }
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
        return resp;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
