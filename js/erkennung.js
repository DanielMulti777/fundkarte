// Koordinaten und Datum aus Text lesen (Texterkennung von Screenshots oder
// Handeingabe). Reine Funktionen ohne Browser-Abhaengigkeit, damit sie mit
// Node testbar sind: node scripts/erkennung_test.mjs

/**
 * Typografische Varianten vereinheitlichen. Die Texterkennung liefert fuer
 * die Minuten-/Sekundenstriche der iPhone-Kompass-App mal ′ ″, mal ' ", mal
 * ’ ” – und fuer das Gradzeichen gelegentlich º oder ˚.
 */
function vereinheitlichen(text) {
  return String(text || '')
    .replace(/[º˚]/g, '°')
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″“”„]/g, '"')
    .replace(/''/g, '"')
    .replace(/ /g, ' ');
}

// Himmelsrichtung -> Vorzeichen und Achse. "O" = Ost in der deutschen Anzeige.
const RICHTUNG = {
  N: ['lat', 1], S: ['lat', -1], E: ['lng', 1], O: ['lng', 1], W: ['lng', -1],
};

const ZAHL = String.raw`\d{1,3}`;
const DEZ = String.raw`\d{1,2}(?:[.,]\d+)?`;

// Reihenfolge wichtig: das genaueste Muster zuerst
// Minutenstrich: ' – die Texterkennung liest den schmalen ′ der iPhone-Schrift aber
// auch als " (echter Screenshot 2026-11: 15°21"11" O). Weil danach noch Sekunden
// und ein " folgen, ist das trotzdem eindeutig.
const MIN = `['"]`;

const MUSTER = [
  // 47°44'15" N  |  47° 44' 15.3" N  |  16°23'50"O  (auch mit "0" statt "O" direkt nach dem ")
  new RegExp(String.raw`(${ZAHL})\s*°\s*(\d{1,2})\s*${MIN}\s*(${DEZ})\s*(?:"\s*([NSEOW0])|"?\s*([NSEOW]))(?![a-zäöü])`, 'gi'),
  // 47°44.250' N  (Grad + Dezimalminuten)
  new RegExp(String.raw`(${ZAHL})\s*°\s*(\d{1,2}[.,]\d+)\s*'\s*([NSEOW])(?![a-zäöü])`, 'gi'),
  // 47.73750° N  |  47,7375 N
  new RegExp(String.raw`(${ZAHL}[.,]\d{3,})\s*°?\s*([NSEOW])(?![a-zäöü])`, 'gi'),
  // Texterkennung hat ein Zeichen verschluckt oder verwechselt:
  // 47°4415" N (Minutenstrich fehlt) | 47°44 15" N | 47o44'15" N | 47*44'15" N
  new RegExp(String.raw`(${ZAHL})\s*[°o*]\s*(\d{2})\s*${MIN}?\s*(\d{2}(?:[.,]\d+)?)\s*(?:"\s*([NSEOW0])|"?\s*([NSEOW]))(?![a-zäöü])`, 'gi'),
  // 4744'15" N (Gradzeichen fehlt; nur zweistellige Grade eindeutig trennbar)
  new RegExp(String.raw`(?<![\d.,])(\d{2})(\d{2})\s*${MIN}\s*(${DEZ})\s*(?:"\s*([NSEOW0])|"?\s*([NSEOW]))(?![a-zäöü])`, 'gi'),
];

const zahl = (s) => Number(String(s).replace(',', '.'));

function teilwerte(text) {
  const t = vereinheitlichen(text);
  const funde = [];
  const belegt = [];
  const frei = (a, b) => !belegt.some(([x, y]) => a < y && b > x);
  MUSTER.forEach((re, art) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const von = m.index; const bis = m.index + m[0].length;
      if (!frei(von, bis)) continue;
      let wert; let richtung;
      if (art === 0 || art === 3 || art === 4) {
        const [g, mi, se] = [zahl(m[1]), zahl(m[2]), zahl(m[3])];
        if (mi >= 60 || se >= 60) continue;
        wert = g + mi / 60 + se / 3600;
        richtung = (m[4] || m[5]).toUpperCase().replace('0', 'O');
      } else if (art === 1) {
        const [g, mi] = [zahl(m[1]), zahl(m[2])];
        if (mi >= 60) continue;
        wert = g + mi / 60;
        richtung = m[3].toUpperCase();
      } else {
        wert = zahl(m[1]);
        richtung = m[2].toUpperCase();
      }
      belegt.push([von, bis]);
      funde.push({ pos: von, wert, richtung, roh: m[0].trim() });
    }
  });
  return funde.sort((a, b) => a.pos - b.pos);
}

function gueltig(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/**
 * Liefert {lat, lng, roh} oder null. Erkennt Grad/Minuten/Sekunden,
 * Grad/Dezimalminuten und Dezimalgrad – mit Himmelsrichtung – sowie ein
 * schlichtes Dezimalpaar "47.7375, 16.3972" (erst Breite, dann Laenge).
 */
export function koordinatenAusText(text) {
  const teile = teilwerte(text);
  const breite = teile.find((x) => RICHTUNG[x.richtung][0] === 'lat');
  const laenge = teile.find((x) => RICHTUNG[x.richtung][0] === 'lng');
  if (breite && laenge) {
    const lat = breite.wert * RICHTUNG[breite.richtung][1];
    const lng = laenge.wert * RICHTUNG[laenge.richtung][1];
    if (gueltig(lat, lng)) return { lat, lng, roh: `${breite.roh} ${laenge.roh}` };
  }
  // Dezimalpaar ohne Richtungsbuchstaben (z. B. aus Google Maps kopiert)
  const t = vereinheitlichen(text);
  const m = t.match(/(-?\d{1,2}\.\d{3,})\s*°?\s*[,;/\s]\s*(-?\d{1,3}\.\d{3,})/);
  if (m) {
    const lat = Number(m[1]); const lng = Number(m[2]);
    if (gueltig(lat, lng)) return { lat, lng, roh: m[0].trim() };
  }
  return null;
}

// ---------- Datum ----------
const MONATE = [
  [/^(jän|jan)/i, 1], [/^feb/i, 2], [/^(mär|mar|maer|mrz)/i, 3], [/^apr/i, 4], [/^(mai|may)/i, 5],
  [/^jun/i, 6], [/^jul/i, 7], [/^aug/i, 8], [/^sep/i, 9], [/^(okt|oct)/i, 10], [/^nov/i, 11],
  [/^(dez|dec)/i, 12],
];
const pad = (n) => String(n).padStart(2, '0');

function monatAusWort(w) {
  const e = MONATE.find(([re]) => re.test(w));
  return e ? e[1] : null;
}

function plausibel(j, m, t, jetzt) {
  if (m < 1 || m > 12 || t < 1 || t > 31) return false;
  if (j < 1950 || j > jetzt.getFullYear() + 1) return false;
  const d = new Date(j, m - 1, t);
  return d.getMonth() === m - 1;
}

function uhrzeitNach(t, ab) {
  // Uhrzeit direkt hinter dem Datum, z. B. "14.06.2025 14:23" oder "14. Juni 2025 um 14:23"
  const m = t.slice(ab, ab + 16).match(/^[\s,]*(?:um\s+)?([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/i);
  return m ? `${pad(m[1])}:${m[2]}` : null;
}

/**
 * Erstes plausibles Datum im Text als "YYYY-MM-DDTHH:MM" (Uhrzeit nur,
 * wenn sie direkt dabeisteht, sonst 12:00) oder null.
 */
export function datumAusText(text, jetzt = new Date()) {
  const t = vereinheitlichen(text);
  const kandidaten = [];
  let m;
  // 14.06.2025 | 14.6.25 | 14/06/2025
  const reNum = /(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?![\d.])/g;
  while ((m = reNum.exec(t))) {
    let j = Number(m[3]); if (j < 100) j += 2000;
    kandidaten.push({ pos: m.index, ende: m.index + m[0].length, j, mo: Number(m[2]), ta: Number(m[1]) });
  }
  // 2025-06-14
  const reIso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
  while ((m = reIso.exec(t))) {
    kandidaten.push({ pos: m.index, ende: m.index + m[0].length, j: Number(m[1]), mo: Number(m[2]), ta: Number(m[3]) });
  }
  // 14. Juni 2025 | 14 Jun. 2025 | 3. Jänner 2024
  const reWort = /(?<!\d)(\d{1,2})\.?\s+([A-Za-zÄÖÜäöü]{3,10})\.?\s+(\d{4})(?!\d)/g;
  while ((m = reWort.exec(t))) {
    const mo = monatAusWort(m[2]);
    if (mo) kandidaten.push({ pos: m.index, ende: m.index + m[0].length, j: Number(m[3]), mo, ta: Number(m[1]) });
  }
  kandidaten.sort((a, b) => a.pos - b.pos);
  const k = kandidaten.find((x) => plausibel(x.j, x.mo, x.ta, jetzt));
  if (!k) return null;
  return `${k.j}-${pad(k.mo)}-${pad(k.ta)}T${uhrzeitNach(t, k.ende) || '12:00'}`;
}

/** Datum-Objekt -> "YYYY-MM-DDTHH:MM" in lokaler Zeit. */
export function alsLokalzeit(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Koordinaten fuer die Anzeige: 47°44′15″ N 16°23′50″ O */
export function alsGradMinSek(lat, lng) {
  const teil = (v, pos, neg) => {
    const a = Math.abs(v);
    let g = Math.floor(a); let mi = Math.floor((a - g) * 60);
    let s = Math.round(((a - g) * 60 - mi) * 60);
    if (s === 60) { s = 0; mi += 1; }
    if (mi === 60) { mi = 0; g += 1; }
    return `${g}°${pad(mi)}′${pad(s)}″ ${v < 0 ? neg : pos}`;
  };
  return `${teil(lat, 'N', 'S')} ${teil(lng, 'O', 'W')}`;
}
