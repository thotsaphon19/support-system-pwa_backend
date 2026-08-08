const CACHE_NAME = 'lazmall-customer-v1';

// App-shell files: always fetched fresh from the network first (falls back to
// cache only when offline), so a new deploy reaches customers immediately —
// no manual cache clearing needed.
const APP_SHELL_PATHS = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json'];

// Rarely-changing static assets: safe to serve from cache first, revalidating
// in the background.
const STATIC_ASSETS = ['./icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(['./', './index.html', './style.css', './app.js', './manifest.json', ...STATIC_ASSETS]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clientsArr) => clientsArr.forEach((c) => c.postMessage({ type: 'SW_UPDATED' })))
  );
});

function isAppShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname.replace(new RegExp('^' + new URL(self.registration.scope).pathname), '/');
  return APP_SHELL_PATHS.includes(path) || path === '/';
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Cache Storage only supports http(s) requests. Requests from browser
  // extensions (chrome-extension://), data: URIs, etc. will throw on
  // cache.put(), so let those pass straight through to the network.
  const url = new URL(event.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // App-shell (HTML/CSS/JS): network-first, so every deploy is picked up on
  // the very next load. Only fall back to the cached copy when offline.
  if (event.request.mode === 'navigate' || isAppShellRequest(url)) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Everything else (icons, third-party assets): cache-first with background revalidation.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// ---------- Real Web Push ----------
// This is what fires even when the app/tab is fully closed — the browser wakes the
// service worker up in the background just to show this. `silent: false` (the
// default, set explicitly here for clarity) is what makes the OS play its normal
// notification sound; `vibrate` adds a vibration pattern too on phones that support
// it, since sound alone can be missed if the phone is on silent/vibrate mode.
// There's no way to play a *custom* sound file from here — only the browser/OS's
// own system notification sound, which the person controls from their own device
// settings (same as every other app's notifications).
self.addEventListener('push', (event) => {
  let payload = { title: 'ฝ่ายบริการ', body: 'คุณมีการแจ้งเตือนใหม่' };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch (e) { /* use default */ }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: payload.tag || 'general',
      data: { url: payload.url || './' },
      silent: false,
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
