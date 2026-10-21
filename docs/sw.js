const CACHE_NAME = 'dailypulse-v21'; // bump on any static asset change (keep in sync with APP_VERSION in app.js)
const STATIC_ASSETS = [
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './world-spinning.gif',
  './india-flag.png',
  './usa-news.jpg',
  './finance-banner.svg',
  './micro-banner.svg',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './icons/apple-touch-icon.svg',
];

self.addEventListener('install', e => {
  // No skipWaiting here: a new SW waits so the page can prompt the user to update,
  // then activates on demand via the SKIP_WAITING message below.
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Page calls this (via the "Reload" button) to activate the waiting SW immediately.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // The digest + any cross-origin asset: network-first so a fresh briefing wins,
  // fall back to cache when offline.
  if (url.pathname.endsWith('/data/digest.json') || url.hostname !== self.location.hostname) {
    e.respondWith(
      fetch(request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Local static assets: cache-first.
  e.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(request, clone));
      }
      return res;
    }))
  );
});
