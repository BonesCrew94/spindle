/*
 * Spindle service worker.
 *
 * Its whole job is to let the app open without a connection. It is
 * deliberately not a caching layer for anything else, because the failure
 * mode of an over-eager service worker is an app that cannot be updated -
 * it keeps serving months-old code while looking perfectly healthy.
 *
 * So: the page itself is fetched from the network first and only falls back
 * to the cache when offline, which means a deploy lands on the next open
 * rather than whenever the browser feels like noticing. Static assets are
 * served from cache and refreshed in the background. Feeds, audio and the
 * sync API are never touched.
 */

const VERSION = 'v14';
const CACHE   = 'spindle-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', e => {
  /* One missing icon should not stop the whole worker installing */
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Lets the page ask a waiting worker to take over immediately. */
self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

const isPage = (req, url) =>
  req.mode === 'navigate' ||
  url.pathname === '/' ||
  url.pathname.endsWith('/index.html');

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Never touch the API. These are all live data - podcast feeds, search
     results, sync state, auth. Caching a feed response means new episodes
     never appear, because the stale copy answers every refresh forever. */
  if (url.pathname.startsWith('/api/')) return;

  /* Audio streams straight from the podcast host. */
  if (req.destination === 'audio') return;
  if (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(url.pathname)) return;

  if (url.origin !== location.origin) return;

  /* The page: network first. This is the line that makes updates arrive on
     their own. The cache is only the offline fallback. */
  if (isPage(req, url)) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then(hit => hit || caches.match('./')))
    );
    return;
  }

  /* Everything else: serve from cache for speed, refresh in the background
     so the next open already has the new copy. */
  e.respondWith(
    caches.match(req).then(hit => {
      const live = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || live;
    })
  );
});
