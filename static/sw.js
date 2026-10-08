/* Academic Ledger service worker — installable app + offline caching.
   Two caches:
     al-shell-v1  precached app shell (HTML, CSS, JS, fonts, icons, manifest)
     al-api-v1    runtime cache of successful GET /api/ responses so the last
                  screen you saw still opens with no connection.
   Bump VERSION whenever the precache list or shell semantics change. */
'use strict';

const VERSION = 'v2';
const SHELL = 'al-shell-' + VERSION;
const API = 'al-api-' + VERSION;
const SHELL_URLS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'favicon.svg',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'maskable-192.png',
  'maskable-512.png',
  'style.css',
  'i18n.js',
  'app.js',
  'fonts/fredoka-400.woff2',
  'fonts/poppins-400.woff2',
  'fonts/poppins-500.woff2',
  'fonts/poppins-600.woff2',
  'fonts/poppins-700.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) =>
        // allSettled: one missing asset must never fail the whole install
        Promise.allSettled(SHELL_URLS.map((u) => cache.add(u)))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('al-') && k !== SHELL && k !== API)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Network first; fall back to the cached copy only when the network fails
   (server asleep / offline), so live data always wins when reachable. */
async function networkFirst(request, cacheName, shellFallback) {
  try {
    const res = await fetch(request);
    if (res && res.ok && cacheName) {
      const cache = await caches.open(cacheName);
      cache.put(request, res.clone());
    }
    return res;
  } catch (err) {
    let hit = await caches.match(request, { ignoreSearch: true });
    if (!hit && shellFallback) hit = await caches.match(shellFallback, { ignoreSearch: true });
    if (!hit && shellFallback) hit = await caches.match('index.html');
    if (hit) return hit;
    throw err;
  }
}

/* Stale-while-revalidate for versioned shell assets: serve the cached copy
   instantly, refresh it in the background. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request, { ignoreSearch: false })
    || await cache.match(request, { ignoreSearch: true });
  const refresh = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => undefined);
  if (cached) {
    refresh; // fire and forget
    return cached;
  }
  const res = await refresh;
  if (res) return res;
  throw new Error('offline and not cached');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // mutations always need the network
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return; // never cache the worker itself
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(networkFirst(req, SHELL, './'));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req, API));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
