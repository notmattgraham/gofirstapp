/*
 * GoFirst service worker.
 *
 * Strategy: network-first with cache fallback.
 *   - Online: always fetch the newest version; update the cache.
 *   - Offline: fall back to the last cached copy.
 * This keeps the installed PWA on your phone auto-updating the moment you
 * open it while on a network, instead of getting stuck on a stale bundle.
 */
// Bumped to v21 — slide-up animation on the Quitting edit sheet
// + centered zoom-in popup variant for the delete confirm. All
// .confirm-overlay sheets app-wide get the open animation
// automatically; close animation kicks in when callers add
// the `.closing` class (Quitting flow does this via the new
// closeOverlayAnimated helper).
const CACHE = 'gofirst-v21';
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

/* ── Push notifications ──────────────────────────────────────────
 * Server posts a JSON body like:
 *   { title, body, url?, tag?, icon? }
 * The handler shows a single notification and (on click) tries to focus
 * an existing app window or open a fresh one at the supplied URL.
 * Empty/malformed payloads still surface a generic notification so the
 * subscription gets the "yes, you're alive" signal instead of a silent
 * delivery (which some browsers count against the origin's reputation).
 */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { title: 'GoFirst', body: (event.data && event.data.text()) || '' }; }
  const title = data.title || 'GoFirst';
  const options = {
    body: data.body || '',
    icon: data.icon || './icon-192.png',
    badge: './icon-192.png',
    // tag groups successive pushes into a single visible notification
    // (e.g. multiple new messages from the same person collapse).
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse a same-origin window if one is open; otherwise pop a new one.
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) {
        await c.focus();
        try { await c.navigate(target); } catch {}
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
