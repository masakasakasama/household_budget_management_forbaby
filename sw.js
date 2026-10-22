// Cache this application's public files only. Never cache Firebase responses or user records.
const PREFIX = 'baby-budget-offline-';
const CACHE = PREFIX + '20261022-v1';
const BASE = new URL('./', self.location.href);
const FILES = [".", "index.html", "app.js", "style.css", "data-backup.js", "sync-config.js", "version.json"];
const allowed = new Set(FILES.map(path => new URL(path, BASE).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...allowed])));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin) return;
  url.search = ''; url.hash = '';
  if (!allowed.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type === 'basic') {
        try { await cache.put(url.href, response.clone()); } catch { /* A full cache must not hide a successful network response. */ }
        return response;
      }
      return await cache.match(url.href) || response;
    } catch (error) {
      const cached = await cache.match(url.href);
      if (cached) return cached;
      throw error;
    }
  })());
});
