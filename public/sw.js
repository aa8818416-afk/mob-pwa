const CACHE_NAME = 'tactile-ai-v2';

// On install: skip waiting immediately, don't pre-cache anything
self.addEventListener('install', () => {
  self.skipWaiting();
});

// On activate: delete ALL old caches to prevent stale file serving
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(cacheNames.map((name) => caches.delete(name)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: Never cache _next/* static files (they change on every build)
// Only cache manifest and icon for offline PWA shell
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Pass through all Next.js static chunks and API calls without caching
  if (
    url.pathname.startsWith('/_next/') ||
    url.pathname.startsWith('/api/') ||
    event.request.method !== 'GET'
  ) {
    return; // Let browser handle normally
  }

  // For navigation requests, try network first, fall back to cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

  // For manifest and icon: cache-first
  if (url.pathname === '/manifest.json' || url.pathname === '/icon.svg') {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then(
          (cached) => cached || fetch(event.request).then((res) => {
            cache.put(event.request, res.clone());
            return res;
          })
        )
      )
    );
  }
});
