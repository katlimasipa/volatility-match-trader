/**
 * ThDpst Matches — Progressive Web App Service Worker
 * Handles offline caching, background sync, and cross-device push notifications.
 */

const CACHE_NAME = 'thdpst-matches-v7';
const STATIC_ASSETS = [
  '/',
  '/trade',
  '/manifest.json',
  '/manifest.webmanifest',
  '/app-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.png',
  '/favicon.ico',
  '/logo.png'
];

// Install: precache app shell and assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Some static assets failed to precache:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up older caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: network-first for HTML navigation, stale-while-revalidate for static assets
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Bypass WebSockets and external auth/API requests
  if (url.protocol.startsWith('ws') || url.hostname.includes('deriv') || url.hostname.includes('supabase')) {
    return;
  }

  // Navigation requests: network-first with cache fallback
  if (request.mode === 'navigate') {
    // Never cache OAuth / Auth 2.0 return URLs — code & state must hit the network
    const isOAuthReturn =
      url.searchParams.has('code') ||
      url.searchParams.has('state') ||
      url.searchParams.has('token1') ||
      url.searchParams.has('acct1') ||
      url.searchParams.has('error');

    // Never cache OAuth returns or the dedicated callback route
    if (isOAuthReturn || url.pathname.startsWith('/deriv/callback')) {
      event.respondWith(fetch(request));
      return;
    }

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cached) => cached || caches.match('/trade') || caches.match('/'));
        })
    );
    return;
  }

  // Static assets (images, css, js, fonts)
  if (
    request.destination === 'image' ||
    request.destination === 'style' ||
    request.destination === 'script' ||
    request.destination === 'font'
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchPromise = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return networkResponse;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    );
    return;
  }

  // Default: try network, then cache
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// Cross-device Push Notifications Handler
self.addEventListener('push', (event) => {
  let payload = {
    title: 'ThDpst Matches Alert',
    body: 'Trade executed on Volatility 100',
    data: { url: '/trade' },
  };

  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload.body = event.data.text();
    }
  }

  const notificationOptions = {
    body: payload.body,
    icon: payload.icon || '/app-icon.png',
    badge: payload.badge || '/favicon.png',
    vibrate: [200, 100, 200],
    tag: payload.tag || 'thdpst-trade-alert',
    renotify: true,
    data: payload.data || { url: '/trade' },
    actions: [
      { action: 'open', title: 'Open Terminal' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  event.waitUntil(
    self.registration
      .getNotifications({ tag: notificationOptions.tag })
      .then((existing) => {
        return self.registration.showNotification(payload.title, {
          ...notificationOptions,
          renotify: existing.length === 0,
        });
      })
      .catch(() => self.registration.showNotification(payload.title, notificationOptions)),
  );
});

// Notification Click Handler: focuses or opens terminal tab
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/trade';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing tab if open
      for (const client of windowClients) {
        if (client.url.includes('/trade') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// Client Message Listener: allows frontend to trigger immediate service-worker notifications
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'TRIGGER_NOTIFICATION') {
    const { title, options } = event.data;
    self.registration.showNotification(title, {
      icon: '/app-icon.png',
      badge: '/favicon.png',
      vibrate: [150, 80, 150],
      tag: 'trade-alert',
      renotify: true,
      data: { url: '/trade' },
      ...options,
    });
  }
});
