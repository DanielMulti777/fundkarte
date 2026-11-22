// Service Worker: App offline startfaehig machen und Kartenkacheln cachen.
// Bei Aenderungen an App-Dateien VERSION erhoehen, damit Handys neu laden.

const VERSION = 'v4';
const APP_CACHE = `app-${VERSION}`;
const KACHEL_LAUFEND = 'kacheln-laufend';
const MAX_LAUFEND = 4000;

const APP_DATEIEN = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/geo.js', 'js/offline.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png',
  'vendor/markercluster/leaflet.markercluster.js', 'vendor/markercluster/MarkerCluster.css',
  'data/bezirke.geojson', 'icons/icon-192.png', 'icons/icon-512.png',
];

const KACHEL_HOSTS = ['tile.openstreetmap.org', 'tile.opentopomap.org', 'mapsneu.wien.gv.at'];
const istKachel = (url) => KACHEL_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_DATEIEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('app-') && k !== APP_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

let puts = 0;
async function laufendKuerzen() {
  const c = await caches.open(KACHEL_LAUFEND);
  const keys = await c.keys();
  // keys() liefert in Einfuegereihenfolge: die aeltesten fliegen zuerst
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_LAUFEND))) await c.delete(k);
}

async function kachel(req) {
  const url = req.url;
  const treffer = await caches.match(url);
  if (treffer) return treffer;
  try {
    // cors statt no-cors: undurchsichtige Antworten belegen im Chrome-Kontingent je ~7 MB
    const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (r.ok) {
      const kopie = r.clone();
      caches.open(KACHEL_LAUFEND).then((c) => c.put(url, kopie)).then(() => { if (++puts % 200 === 0) laufendKuerzen(); });
    }
    return r;
  } catch {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

async function appDatei(req) {
  const cache = await caches.open(APP_CACHE);
  const treffer = await cache.match(req, { ignoreSearch: true });
  const netz = fetch(req).then((r) => {
    if (r.ok) cache.put(req, r.clone());
    return r;
  }).catch(() => null);
  if (treffer) return treffer; // sofort aus dem Cache, im Hintergrund aktualisieren
  const r = await netz;
  if (r) return r;
  if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
  return new Response('', { status: 504, statusText: 'offline' });
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (istKachel(url)) e.respondWith(kachel(e.request));
  else if (url.origin === self.location.origin) e.respondWith(appDatei(e.request));
});
