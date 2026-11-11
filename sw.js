// Bunker Atlas service worker: makes the app installable and usable offline.
//
// - App shell (HTML/CSS/JS/icons + MapLibre from the CDN): precached, served
//   cache-first. Bump VERSION on every deploy so users get the new files.
// - Bunker data: network-first, falls back to the cached copy when offline.
// - Map tiles and fonts: cached as they are viewed (cache-first), capped so the
//   cache can't grow forever. Areas you've looked at keep working offline.

const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const DATA = 'data';
const TILES = 'tiles';
const MAX_TILES = 1500;

const SHELL_FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/config.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];
const DATA_FILES = ['data/bunkers.geojson'];

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
  'server.arcgisonline.com',
  'demotiles.maplibre.org',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_FILES);
    await (await caches.open(DATA)).addAll(DATA_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, DATA, TILES]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin && url.pathname.endsWith('.geojson')) {
    event.respondWith(networkFirst(req, DATA));
  } else if (TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
    event.respondWith(tileCacheFirst(req, event));
  } else if (req.mode === 'navigate') {
    // Any page load inside the app → the cached index (keeps #id links working offline).
    event.respondWith(networkFirst(req, SHELL, 'index.html'));
  } else {
    event.respondWith(cacheFirst(req, SHELL));
  }
});

async function cacheFirst(req, cacheName) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && new URL(req.url).origin === location.origin) {
    (await caches.open(cacheName)).put(req, res.clone());
  }
  return res;
}

async function networkFirst(req, cacheName, fallbackPath) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(fallbackPath || req, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(fallbackPath || req, { ignoreSearch: true }))
      || (fallbackPath && await cache.match('./'));
    if (hit) return hit;
    throw err;
  }
}

async function tileCacheFirst(req, event) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Only cache real (CORS) responses; opaque ones can't be checked and eat quota.
  if (res.ok && res.type !== 'opaque') {
    await cache.put(req, res.clone());
    event.waitUntil(trim(cache));
  }
  return res;
}

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    // Cache keys come back in insertion order: drop the oldest first.
    for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
  } finally {
    trimming = false;
  }
}
