// Kartenebenen und Offline-Download von Kacheln fuer einen Bezirk.
//
// Bulk-Download nur fuer basemap.at (offene Verwaltungsdaten, CC BY 4.0).
// OpenStreetMap und OpenTopoMap untersagen in ihren Nutzungsregeln das
// Vorab-Herunterladen ganzer Gebiete; dort werden nur angesehene Kacheln
// vom Service Worker zwischengespeichert (normales Browser-Verhalten).

import { kachelnFuerGebiet } from './geo.js';

const BASEMAP = 'Datenquelle: <a href="https://basemap.at" target="_blank" rel="noopener">basemap.at</a> (CC BY 4.0)';
const OSM = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende';

export const EBENEN = [
  {
    id: 'osm', name: 'Straßenkarte', quelle: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, maxNativeZoom: 19,
    attribution: OSM, offline: false,
  },
  {
    id: 'bmap', name: 'Karte Österreich', quelle: 'basemap.at',
    url: 'https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png',
    maxZoom: 19, maxNativeZoom: 19, attribution: BASEMAP, offline: true, kb: 20,
  },
  {
    id: 'ortho', name: 'Satellit / Luftbild', quelle: 'basemap.at',
    url: 'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg',
    maxZoom: 19, maxNativeZoom: 19, attribution: BASEMAP, offline: true, kb: 20,
  },
  {
    id: 'topo', name: 'Topografie mit Höhenlinien', quelle: 'OpenTopoMap',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', subdomains: 'abc', maxZoom: 19, maxNativeZoom: 17,
    attribution: `Karte: © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA), Daten: ${OSM}, SRTM`,
    offline: false,
  },
  {
    id: 'gelaende', name: 'Gelände-Relief', quelle: 'basemap.at',
    url: 'https://mapsneu.wien.gv.at/basemap/bmapgelaende/grau/google3857/{z}/{y}/{x}.jpeg',
    maxZoom: 19, maxNativeZoom: 17, attribution: BASEMAP, offline: true, kb: 6,
  },
];

export const CACHE_OFFLINE = 'kacheln-offline';

function kachelUrl(ebene, { z, x, y }) {
  return ebene.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

export function planen(bezirkFeature, ebenenIds, zMax) {
  const kacheln = kachelnFuerGebiet(bezirkFeature, 8, zMax);
  const ebenen = EBENEN.filter((e) => ebenenIds.includes(e.id));
  const urls = [];
  let kb = 0;
  for (const e of ebenen) {
    const zGrenze = Math.min(zMax, e.maxNativeZoom);
    for (const k of kacheln) {
      if (k.z > zGrenze) continue;
      urls.push(kachelUrl(e, k));
      kb += e.kb;
    }
  }
  return { urls, mb: kb / 1024 };
}

/**
 * Laedt die Kacheln mit begrenzter Parallelitaet in den Cache.
 * Bereits vorhandene werden uebersprungen – ein abgebrochener Download
 * laesst sich so einfach fortsetzen.
 */
export async function herunterladen(urls, { onFortschritt, signal }) {
  const cache = await caches.open(CACHE_OFFLINE);
  let fertig = 0; let fehler = 0; let i = 0;
  const PARALLEL = 4;
  async function arbeiter() {
    while (i < urls.length) {
      if (signal.aborted) return;
      const url = urls[i++];
      try {
        if (!(await cache.match(url))) {
          const r = await fetch(url, { mode: 'cors', signal });
          // 404 = keine Kachel an dieser Stelle (z. B. jenseits der Grenze): kein Fehler
          if (r.ok) await cache.put(url, r);
          else if (r.status !== 404) fehler++;
        }
      } catch (e) {
        if (signal.aborted) return;
        fehler++;
      }
      fertig++;
      if (fertig % 10 === 0 || fertig === urls.length) onFortschritt(fertig, urls.length, fehler);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, arbeiter));
  onFortschritt(fertig, urls.length, fehler);
  return { fertig, fehler };
}

export async function bestand() {
  if (!('caches' in window)) return { anzahl: 0 };
  const c = await caches.open(CACHE_OFFLINE);
  const keys = await c.keys();
  return { anzahl: keys.length };
}

export async function allesLoeschen() {
  await caches.delete(CACHE_OFFLINE);
}
