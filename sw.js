// OrthoDeck service worker.
//
// Bump CACHE_VERSION whenever you change app files so installed phones pick up
// the update on the next launch. The page compares this version string against
// the one it is already running and only announces an update when they differ,
// so a worker that re-installs itself unchanged (which iOS does on its own when
// it evicts the stored script) no longer produces a false "Update ready".
const CACHE_VERSION = 'orthodeck-v14';
const IMAGE_CACHE = 'orthodeck-images';

// Assets the app cannot start without. If one of these fails the install fails.
const CORE = [
  './',
  './index.html',
  './app.js',
  './db.js',
  './cards.js',
  './sync.js',
  './manifest.json'
];
// Nice to have offline. pdf.worker.min.mjs is 1.4 MB and a flaky connection
// used to fail the whole install (cache.addAll is all-or-nothing), which left
// the app re-installing the same worker over and over. These are cached
// best-effort instead and fetched on demand later if they are missing.
const OPTIONAL = [
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs'
];

// Install must never fail. cache.addAll is all-or-nothing, so one slow fetch on
// a weak signal used to fail the whole install: the worker went redundant, the
// page was told nothing, and the phone sat on the old build through any number
// of restarts. Everything is cached best-effort now and the fetch handler falls
// back to the network for anything that did not make it.
let missed = [];
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    missed = [];
    for (const url of CORE.concat(OPTIONAL)) {
      try { await cache.add(url); } catch (e) { missed.push(url); }
    }
    // Deliberately no skipWaiting() here. The page activates a genuinely new
    // version itself once it has compared versions, so the notice stays true.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== IMAGE_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'VERSION') {
    const reply = { type: 'VERSION', version: CACHE_VERSION, missed: missed.slice() };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  } else if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Never serve the Dropbox API from cache.
  if (url.hostname.endsWith('dropboxapi.com') || url.hostname === 'www.dropbox.com') return;
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
