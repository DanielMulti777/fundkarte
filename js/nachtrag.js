// Bilder fuer "Alte Funde nachtragen" auswerten: GPS und Datum aus den
// Fotodaten (EXIF), sonst Koordinaten/Datum per Texterkennung aus Screenshots.
//
// Beide Bibliotheken liegen unter vendor/ und werden erst beim ersten Nachtragen
// geladen (Texterkennung ~7 MB) – danach cacht sie der Service Worker, die
// Erkennung laeuft komplett am Geraet, nichts verlaesst das Handy.

import { alsLokalzeit, datumAusText, koordinatenAusText } from './erkennung.js';

function skriptLaden(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Konnte ${src} nicht laden`));
    document.head.append(s);
  });
}

let exifrLaden = null;
async function exifr() {
  if (!window.exifr) await (exifrLaden ||= skriptLaden('vendor/exifr/full.umd.js'));
  return window.exifr;
}

let ocrWorker = null;
export let ocrStatus = 'aus'; // aus | laedt | bereit | fehler
async function texterkennung() {
  if (!ocrWorker) {
    ocrStatus = 'laedt';
    ocrWorker = (async () => {
      await skriptLaden('vendor/tesseract/tesseract.min.js');
      const basis = new URL('vendor/tesseract/', location.href).href;
      // OEM 1 = nur LSTM: passt zu den mitgelieferten *-lstm.wasm.js-Kernen
      const w = await window.Tesseract.createWorker('eng', 1, {
        workerPath: `${basis}worker.min.js`,
        corePath: `${basis}core`,
        langPath: `${basis}lang`,
        gzip: true,
        // Standardweg von Tesseract: kleiner Blob-Worker, der worker.min.js per
        // importScripts nachlaedt. Direkt per URL gestartete Worker scheitern in
        // manchen eingebetteten Browsern (z. B. In-App-Browsern) stillschweigend.
        workerBlobURL: true,
      });
      ocrStatus = 'bereit';
      return w;
    })().catch((e) => {
      ocrStatus = 'fehler'; ocrWorker = null;
      // Tesseract verwirft manchmal ohne Fehlerobjekt – dann wenigstens eine lesbare Meldung
      throw e instanceof Error ? e : new Error(String(e ?? 'Texterkennung konnte nicht starten'));
    });
  }
  return ocrWorker;
}

async function bildLaden(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Bild nicht lesbar'));
      i.src = URL.createObjectURL(file);
    });
  }
}

/**
 * Bild fuer die Texterkennung aufbereiten: verkleinern, Graustufen, und
 * dunkle Bilder invertieren – die Kompass-App zeigt weisse Schrift auf
 * Schwarz, damit tut sich die Erkennung deutlich schwerer.
 */
async function fuerOcr(file) {
  const bild = await bildLaden(file);
  const s = Math.min(1, 2000 / Math.max(bild.width, bild.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bild.width * s); c.height = Math.round(bild.height * s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bild, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let summe = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
    summe += g;
  }
  if (summe / (d.length / 4) < 110) {
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function textErkennen(file) {
  const w = await texterkennung();
  const { data } = await w.recognize(await fuerOcr(file));
  return data.text || '';
}

/**
 * Wertet ein Bild aus. Ergebnis:
 *   { lat, lng, ortQuelle: 'foto'|'screenshot'|null, datum, datumQuelle: 'foto'|'screenshot'|'datei'|null,
 *     istFoto, ocrText, hinweis }
 */
export async function bildAuswerten(file) {
  const e = {
    lat: null, lng: null, ortQuelle: null, roh: '', datum: null, datumQuelle: null,
    istFoto: true, ocrText: '', hinweis: '',
  };
  let meta = null;
  try {
    meta = await (await exifr()).parse(file, { tiff: true, exif: true, gps: true, xmp: false, iptc: false, icc: false });
  } catch { /* keine oder kaputte Metadaten */ }

  if (meta && Number.isFinite(meta.latitude) && Number.isFinite(meta.longitude)
      && !(meta.latitude === 0 && meta.longitude === 0)) {
    e.lat = meta.latitude; e.lng = meta.longitude; e.ortQuelle = 'foto';
  }
  const exifDatum = alsLokalzeit(meta?.DateTimeOriginal || meta?.CreateDate || meta?.DateTimeDigitized);

  const kommentar = String(meta?.UserComment ?? '');
  const istScreenshot = /screenshot|bildschirmfoto/i.test(`${kommentar} ${file.name}`) || file.type === 'image/png';
  const kamera = !!(meta?.Make || meta?.Model);

  // Ohne GPS immer Texterkennung: Screenshots aus der iPhone-Mediathek kommen
  // teils als JPEG mit Kameradaten an und waeren sonst nicht als Screenshot
  // erkennbar. Bei echten Kamerafotos kostet das nur ein, zwei Sekunden im Hintergrund.
  if (e.lat == null) {
    try {
      e.ocrText = await textErkennen(file);
      const k = koordinatenAusText(e.ocrText);
      if (k) { e.lat = k.lat; e.lng = k.lng; e.roh = k.roh; e.ortQuelle = 'screenshot'; }
      const d = datumAusText(e.ocrText);
      if (d) { e.datum = d; e.datumQuelle = 'screenshot'; }
    } catch (err) {
      e.hinweis = `Texterkennung nicht verfügbar (${err?.message ?? err}).`;
    }
  }
  e.istFoto = !istScreenshot && e.ortQuelle !== 'screenshot';

  if (!e.datum && exifDatum) { e.datum = exifDatum; e.datumQuelle = 'foto'; }
  if (!e.datum && file.lastModified) { e.datum = alsLokalzeit(new Date(file.lastModified)); e.datumQuelle = 'datei'; }

  if (e.lat == null && kamera && !istScreenshot) {
    e.hinweis ||= 'Im Foto ist kein Standort gespeichert. Am iPhone hilft es oft, Fotos über „Dateien“ statt über die Mediathek auszuwählen.';
  }
  return e;
}

export const dateiSchluessel = (file) => `${file.name}|${file.size}`;
