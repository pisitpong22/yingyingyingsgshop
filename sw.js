// Minimal Service Worker — registered by index.html.
// Currently a no-op (just claims clients). We don't aggressively pre-cache
// anything because the Firebase Storage bucket lives in Singapore now and
// images are fast enough without a worker-side cache.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Don't intercept fetches — let the browser handle everything normally
