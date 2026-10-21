// Offline support.  Serves the app from the cache, and refreshes the cache in
// the background so the next launch picks up a new version.
const CACHE = 'haskell-repl-v2';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'repl.js', 'worker.js',
  'vendor/editor.js', 'mhs/mhs.js', 'mhs/mhs.wasm',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => {
      if (res.ok && !res.redirected) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) {
      e.waitUntil(fresh);
      return cached;
    }
    return (await fresh) || new Response('Offline', { status: 503 });
  })());
});
