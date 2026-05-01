// FlowState Service Worker v1.0
// Provides offline fallback, asset caching, and background sync

const CACHE_NAME = 'flowstate-v3';
const STATIC_ASSETS = [
  '/',
  '/static/app.js',
  '/static/favicon.svg',
  '/static/site.webmanifest',
  '/manifest.json',
];

// On install: cache static shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Don't fail install if some assets fail (e.g. CDN unavailable)
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

// On activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
// - API requests → network only (never cache sensitive data)
// - Static assets → cache-first with network fallback
// - Navigation → network-first with offline fallback
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests and browser extensions
  if (event.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // API routes — always hit network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/u/')) return;

  // CDN assets (FontAwesome, etc.) — cache with long TTL
  if (url.hostname !== location.hostname) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          }
          return res;
        }).catch(() => cached || new Response('Offline', { status: 503 }));
      })
    );
    return;
  }

  // Same-origin navigation — network first, fallback to cached shell
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/').then((cached) => cached || new Response('Offline — open FlowState when connected', { status: 503 }))
      )
    );
    return;
  }

  // Same-origin static assets — cache first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && event.request.url.includes('/static/')) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        }
        return res;
      });
    })
  );
});

// Handle push notifications (for future session reminders)
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'FlowState', {
        body: data.body || 'Time to focus ⚡',
        icon: '/static/icon-192.png',
        badge: '/static/favicon.svg',
        tag: 'flowstate-notification',
        data: { url: data.url || '/' },
      })
    );
  } catch (_) {}
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
