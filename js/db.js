// Lokaler Speicher: IndexedDB. Funde und Fotos getrennt, damit Liste und
// Karte die (grossen) Fotos nicht mitladen muessen.

const DB_NAME = 'fundkarte';
const DB_VERSION = 1;
let dbPromise = null;

function oeffnen() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('funde')) db.createObjectStore('funde', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('fotos')) db.createObjectStore('fotos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('einstellungen')) db.createObjectStore('einstellungen');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await oeffnen();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let ergebnis;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { ergebnis = r.result; };
    t.oncomplete = () => resolve(ergebnis);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const alleFunde = () => tx('funde', 'readonly', (s) => s.getAll());
export const fundSpeichern = (f) => tx('funde', 'readwrite', (s) => s.put(f));
export const fundLoeschen = (id) => tx('funde', 'readwrite', (s) => s.delete(id));

export const fotoLaden = async (id) => (id ? (await tx('fotos', 'readonly', (s) => s.get(id)))?.blob : null);
export const fotoSpeichern = (id, blob) => tx('fotos', 'readwrite', (s) => s.put({ id, blob }));
export const fotoLoeschen = (id) => tx('fotos', 'readwrite', (s) => s.delete(id));

export const einstellungLesen = (k) => tx('einstellungen', 'readonly', (s) => s.get(k));
export const einstellungSchreiben = (k, v) => tx('einstellungen', 'readwrite', (s) => s.put(v, k));

export function neueId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Ohne "persist" darf der Browser die Daten bei Speicherknappheit raeumen.
export async function dauerhaftAnfordern() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch { return false; }
}
