/*
 * GoFirst service worker.
 *
 * Strategy: network-first with cache fallback.
 *   - Online: always fetch the newest version; update the cache.
 *   - Offline: fall back to the last cached copy.
 * This keeps the installed PWA on your phone auto-updating the moment you
 * open it while on a network, instead of getting stuck on a stale bundle.
 */
const CACHE = 'gofirst-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './applogo.svg',
  './appicon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './icon-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // API and OAuth traffic must go straight to the network — never cache.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Only cache basic same-origin responses
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
