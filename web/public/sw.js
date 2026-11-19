// Relaydeck service worker: offline shell for the GUI.
// API and WebSocket traffic always bypass the cache (checked first, below).
const CACHE = 'relaydeck-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/app-192.png', '/icons/app-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  // Never cache live data or the live socket.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  if (url.pathname.startsWith('/assets/')) {
    // Content-hashed bundles: network first, fall back to the cached copy.
    event.respondWith(fetch(request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy));
      return response;
    }).catch(() => caches.match(request)));
    return;
  }
  // App shell: cache first so the GUI opens instantly on the next visit.
  event.respondWith(caches.match(request).then(hit => hit || fetch(request)));
});
