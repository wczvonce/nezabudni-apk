const CACHE = 'nezabudni-v19-shell-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
// Google Fonts: CSS aj font súbory sa cachujú, aby offline PWA nepadla na fallback fonty.
const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
// Runtime cache nesmie rásť donekonečna (hashované assety z každého deployu).
const MAX_RUNTIME_ENTRIES = 80;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

function cacheable(request, response) {
  const origin = new URL(request.url).origin;
  if (origin === self.location.origin) return response.ok;
  // no-cors požiadavky na fonty vracajú opaque odpoveď (response.ok === false).
  if (FONT_ORIGINS.includes(origin)) return response.ok || response.type === 'opaque';
  return false;
}

async function putWithTrim(request, response) {
  const cache = await caches.open(CACHE);
  await cache.put(request, response);
  const keys = await cache.keys();
  let excess = keys.length - MAX_RUNTIME_ENTRIES;
  if (excess <= 0) return;
  const shellUrls = new Set(SHELL.map((path) => new URL(path, self.location.origin).href));
  for (const key of keys) {
    if (excess <= 0) break;
    if (shellUrls.has(key.url)) continue;
    await cache.delete(key);
    excess -= 1;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then((response) => {
      // Chybovú stránku (500, captive portál…) NIKDY neukladaj ako app shell –
      // otrávila by každý ďalší offline štart aplikácie.
      if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put('/', copy)); }
      return response;
    }).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (cacheable(event.request, response)) { const copy = response.clone(); putWithTrim(event.request, copy); }
    return response;
  })));
});
