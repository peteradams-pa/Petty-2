// sw.js — Offline-first caching for the Petty Cash PWA.
// Bump CACHE_VERSION whenever app files change so clients pick up the update.
const CACHE_VERSION = 'petty-cash-v1.3.0';
const CACHE_NAME = `petty-cash-cache-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './js/app.js',
  './js/db.js',
  './js/excel.js',
  './js/charts.js',
  './js/crypto-helper.js',
  './icons/icon-192.svg',
  './icons/icon-512.svg'
];

// Third-party CDN assets are cached opportunistically at runtime (see fetch handler)
// rather than pre-cached, since CDN availability during install can vary.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key.startsWith('petty-cash-cache-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          // Same-origin responses report a real status; cross-origin CDN
          // script/style requests (Tailwind, Dexie, SheetJS, Chart.js) come
          // back as "opaque" responses with status 0 — cache those too, or
          // the app never actually works offline despite appearing to.
          if (response && (response.status === 200 || response.type === 'opaque')) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return response;
        })
        .catch(() => cached); // offline fallback to cache

      // Cache-first for the app shell (instant load); network-first-ish for CDN libs
      return cached || networkFetch;
    })
  );
});

// Allow the page to trigger immediate activation of a waiting worker
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
