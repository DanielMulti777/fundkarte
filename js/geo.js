// Grenzen (Bezirke, Gemeinden), Punkt-in-Polygon und Kachel-Mathematik.

let bezirkeCache = null;
const gemeindenCache = new Map();

export async function bezirkeLaden() {
  if (!bezirkeCache) {
    const r = await fetch('data/bezirke.geojson');
    bezirkeCache = await r.json();
  }
  return bezirkeCache;
}

export async function gemeindenLaden(gkz) {
  if (!gemeindenCache.has(gkz)) {
    gemeindenCache.set(gkz, fetch(`data/gemeinden/${gkz}.geojson`).then((r) => {
      if (!r.ok) throw new Error('Gemeinden nicht gefunden');
      return r.json();
    }).catch((e) => { gemeindenCache.delete(gkz); throw e; }));
  }
  return gemeindenCache.get(gkz);
}

function imRing(x, y, ring) {
  let drin = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) drin = !drin;
  }
  return drin;
}

export function imFeature(lng, lat, feature) {
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some((p) => imRing(lng, lat, p[0]) && !p.slice(1).some((loch) => imRing(lng, lat, loch)));
}

function bboxEnthaelt(bb, lng, lat) {
  return lng >= bb[0] && lng <= bb[2] && lat >= bb[1] && lat <= bb[3];
}

export function bezirkFinden(fc, lat, lng) {
  return fc.features.find((f) => bboxEnthaelt(f.properties.bbox, lng, lat) && imFeature(lng, lat, f)) || null;
}

/** Bezirk und Gemeinde zu einer Position; null-Felder ausserhalb Oesterreichs. */
export async function ortBestimmen(lat, lng) {
  const bez = await bezirkeLaden();
  const b = bezirkFinden(bez, lat, lng);
  // Bezirke sind staerker vereinfacht als Gemeinden: an Grenzen entstehen schmale
  // Streifen, in denen der Bezirk nicht zur Gemeinde passt oder ganz fehlt. Dann
  // gewinnt die genauere Gemeindegrenze, gesucht in allen Bezirken der Umgebung.
  const kandidaten = [b, ...bez.features.filter((f) => f !== b && bboxEnthaelt(f.properties.bbox, lng, lat))].filter(Boolean);
  for (const k of kandidaten) {
    try {
      const gem = await gemeindenLaden(k.properties.gkz);
      const g = gem.features.find((f) => imFeature(lng, lat, f));
      if (g) return { bezirk: k.properties.name, bezirkGkz: k.properties.gkz, gemeinde: g.properties.name };
    } catch { /* offline und nicht gecacht: naechster Kandidat */ }
  }
  // Letzter Ausweg fuer Luecken zwischen vereinfachten Grenzen: naechste Gemeinde bis ~150 m
  let best = null;
  for (const k of kandidaten) {
    try {
      const gem = await gemeindenLaden(k.properties.gkz);
      for (const f of gem.features) {
        const d = abstandZuFeature(lng, lat, f);
        if (!best || d < best.d) best = { d, k, f };
      }
    } catch { /* offline */ }
  }
  if (best && best.d < 150) return { bezirk: best.k.properties.name, bezirkGkz: best.k.properties.gkz, gemeinde: best.f.properties.name };
  if (!b) return { bezirk: null, bezirkGkz: null, gemeinde: null };
  return { bezirk: b.properties.name, bezirkGkz: b.properties.gkz, gemeinde: null };
}

/** Kleinster Abstand (Meter, Naeherung) vom Punkt zur Grenze eines Features. */
function abstandZuFeature(lng, lat, feature) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180); const ky = 110540;
  const polys = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  let min = Infinity;
  for (const p of polys) {
    for (const r of p) {
      for (let i = 0; i < r.length - 1; i++) {
        const ax = (r[i][0] - lng) * kx; const ay = (r[i][1] - lat) * ky;
        const bx = (r[i + 1][0] - lng) * kx; const by = (r[i + 1][1] - lat) * ky;
        const dx = bx - ax; const dy = by - ay;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        min = Math.min(min, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
  }
  return min;
}

// ---------- Kacheln (Web Mercator) ----------
export function lng2x(lng, z) { return ((lng + 180) / 360) * 2 ** z; }
export function lat2y(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
function x2lng(x, z) { return (x / 2 ** z) * 360 - 180; }
function y2lat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Alle Kacheln von zMin..zMax, die das Gebiet beruehren. Bis Zoom 14 exakt
 * geprueft (Ecken/Mitte im Polygon oder Polygonpunkt in der Kachel), darueber
 * werden nur die Kinder der Treffer genommen – sonst dauert die Pruefung fuer
 * grosse Bezirke (Liezen, Lienz) am Handy Minuten.
 */
const Z_EXAKT = 14;
export function kachelnFuerGebiet(feature, zMin, zMax) {
  const liste = kachelnExakt(feature, zMin, Math.min(zMax, Z_EXAKT));
  let ebene = liste.filter((k) => k.z === Z_EXAKT);
  for (let z = Z_EXAKT + 1; z <= zMax; z++) {
    const naechste = [];
    for (const { x, y } of ebene) {
      naechste.push({ z, x: 2 * x, y: 2 * y }, { z, x: 2 * x + 1, y: 2 * y },
        { z, x: 2 * x, y: 2 * y + 1 }, { z, x: 2 * x + 1, y: 2 * y + 1 });
    }
    liste.push(...naechste);
    ebene = naechste;
  }
  return liste;
}

function kachelnExakt(feature, zMin, zMax) {
  const [w, s, o, n] = feature.properties.bbox;
  const ringe = (feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates)
    .map((p) => p[0]);
  const liste = [];
  for (let z = zMin; z <= zMax; z++) {
    const x0 = Math.floor(lng2x(w, z)); const x1 = Math.floor(lng2x(o, z));
    const y0 = Math.floor(lat2y(n, z)); const y1 = Math.floor(lat2y(s, z));
    // Polygonpunkte je Kachel vormerken
    const mitPunkt = new Set();
    for (const r of ringe) for (const [lng, lat] of r) mitPunkt.add(`${Math.floor(lng2x(lng, z))}/${Math.floor(lat2y(lat, z))}`);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        let treffer = z <= 10 || mitPunkt.has(`${x}/${y}`);
        if (!treffer) {
          const pts = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1], [x + 0.5, y + 0.5]];
          treffer = pts.some(([px, py]) => imFeature(x2lng(px, z), y2lat(py, z), feature));
        }
        if (treffer) liste.push({ z, x, y });
      }
    }
  }
  return liste;
}
