/* global L */
// Schmetterlings-Datenbank (Tagfalter aus GBIF) als zweite Ansicht der Karte.
//
// Herausgezoomt: ~5x5-km-Kaestchen (data/falter/raster.json), eingefaerbt nach
// Artenzahl bzw. – mit Artfilter – nach Anzahl Sichtungen. Ab Zoom 11 einzelne
// Sichtungen aus data/falter/b/<gkz>.json (nur Bezirke im Blickfeld, wie bei
// den Gemeindegrenzen). Aufbereitet von scripts/schmetterlinge_holen.py.

const BLOECKE = [0, 1950, 1980, 2000, 2010, 2020]; // muss zum Skript passen
const BLOCK_NAMEN = ['vor 1950', '1950–1979', '1980–1999', '2000–2009', '2010–2019', 'seit 2020'];
const BLOCK_FARBEN = ['#6b6b8a', '#4f7fae', '#3f9a8c', '#86a83a', '#e0a22b', '#d9531e'];
const DETAIL_AB_ZOOM = 11;
// Radius der Sichtungspunkte in Pixel: herausgezoomt kleiner, sonst nur ein Teppich
const punktRadius = (z) => (z <= 11 ? 3 : (z === 12 ? 4 : 5));
// Abstand zu Kartenknoepfen und unterer Knopfleiste wie bei den eigenen Funden
const POPUP = { maxWidth: 260, autoPanPaddingTopLeft: [64, 170], autoPanPaddingBottomRight: [12, 96] }; // oben Platz fuer Satellit-Knopf und Filter-Chip
// Kaestchen: hell -> dunkel; bewusst Orange/Braun, damit nichts nach eigenen Funden aussieht
const STUFEN_FARBEN = ['#fde7c3', '#fbc77f', '#f7a03f', '#e3741c', '#b8510c', '#7f3307'];
const STUFEN_ARTEN = [1, 3, 6, 12, 25, 45];
const STUFEN_SICHT = [1, 3, 6, 12, 25, 50];

let k = null; // Kontext aus app.js: { map, db, toast, esc, cluster, bezirke, panelOeffnen }
let meta = null; let arten = []; let raster = null;
let ladenP = null;
const zustand = { ansicht: 'funde', arten: new Set(), von: null, bis: null, sort: 'name', suche: '' };

// tolerance: Fingertipp bis ~10 px neben dem Punkt zaehlt noch als Treffer
const renderer = L.canvas({ padding: 0.3, tolerance: 10 });
const rasterLayer = L.layerGroup();

// Einzelsichtungen als selbst gezeichnete Kacheln statt als Leaflet-Objekte:
// In dichten Gegenden (Stadt Salzburg: 56.000 Sichtungen bei Zoom 11) waeren
// zehntausende CircleMarker zu viel fuer jedes Handy. Gezeichnet wird je
// 256-px-Kachel aus vorab projizierten Koordinaten; ein Tipp sucht den naechsten Punkt.
// Ein "Punkt" ist eine Stelle: alle Sichtungen mit genau derselben Koordinate
// (oft Sammelangaben mit ungefaehrem Fundort – bei Linz liegen 6.000 auf einem Fleck).
let punkte = []; // { y, x, b, eintraege: [{ sp, i, jahr }] } – aelteste zuerst, neue obenauf
let projZoom = null; let projX = null; let projY = null;
function projektion(z) {
  if (projZoom === z && projX) return;
  projX = new Float64Array(punkte.length); projY = new Float64Array(punkte.length);
  for (let j = 0; j < punkte.length; j++) {
    const pt = k.map.project([punkte[j].y, punkte[j].x], z);
    projX[j] = pt.x; projY[j] = pt.y;
  }
  projZoom = z;
}
const PunktLayer = L.GridLayer.extend({
  options: { pane: 'falterPunkte', updateWhenZooming: false, keepBuffer: 1 },
  createTile(c) {
    const t = document.createElement('canvas');
    const g = this.getTileSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    t.width = g.x * dpr; t.height = g.y * dpr;
    t.style.width = `${g.x}px`; t.style.height = `${g.y}px`;
    const ctx = t.getContext('2d');
    ctx.scale(dpr, dpr);
    projektion(c.z);
    const R = punktRadius(c.z);
    const ox = c.x * g.x; const oy = c.y * g.y; const r = R + 12;
    ctx.lineWidth = R > 3 ? 1.5 : 1; ctx.strokeStyle = '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let j = 0; j < punkte.length; j++) {
      const x = projX[j] - ox; const y = projY[j] - oy;
      if (x < -r || y < -r || x > g.x + r || y > g.y + r) continue;
      const n = punkte[j].eintraege.length;
      const rad = stapelRadius(R, n);
      ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * Math.PI);
      ctx.fillStyle = BLOCK_FARBEN[punkte[j].b]; ctx.fill(); ctx.stroke();
      // Anzahl nur, wenn genug Platz ist (ab Zoom 12)
      if (n > 1 && R >= 4) {
        ctx.fillStyle = '#fff';
        ctx.font = `700 ${n > 99 ? 8 : 9}px system-ui, sans-serif`;
        ctx.fillText(n > 999 ? '999+' : String(n), x, y + 0.5);
      }
    }
    return t;
  },
});
const detailLayer = new PunktLayer();
// Stapel werden etwas groesser, damit die Zahl hineinpasst und man sie erkennt
function stapelRadius(R, n) { return n > 1 ? R + Math.min(7, 2 + Math.log2(n) * 1.3) : R; }
let falterPopup = null;
const bezirkDaten = new Map(); // gkz -> Promise<spalten>
let ungenauKreis = null;

const $ = (s) => document.querySelector(s);
const jahrVon = () => zustand.von ?? -Infinity;
const jahrBis = () => zustand.bis ?? Infinity;

function datenLaden() {
  ladenP ||= Promise.all(['meta', 'arten', 'raster'].map((n) => fetch(`data/falter/${n}.json`).then((r) => {
    if (!r.ok) throw new Error(`${n}.json fehlt`);
    return r.json();
  }))).then(([m, a, r]) => { meta = m; arten = a; raster = r; })
    .catch((e) => { ladenP = null; throw e; });
  return ladenP;
}

/** Welche Zeitbloecke beruehrt der Filter? (Uebersicht kennt nur Bloecke) */
function aktiveBloecke() {
  return BLOECKE.map((start, i) => {
    const ende = i + 1 < BLOECKE.length ? BLOECKE[i + 1] - 1 : Infinity;
    return start <= jahrBis() && ende >= jahrVon();
  });
}

function artName(i) { return arten[i]?.d || arten[i]?.w || '?'; }

// ---------- Ansicht steuern ----------
export async function falterStarten(kontext) {
  k = kontext;
  // Passt index.html nicht zum Code (halb aktualisierter Cache), lieber still
  // aussetzen als den App-Start mit einem Fehler abbrechen
  if (!document.getElementById('panelFalter')) return;
  const gespeichert = await k.db.einstellungLesen('falter');
  if (gespeichert) {
    Object.assign(zustand, gespeichert, { arten: new Set(gespeichert.arten || []), suche: '' });
  }
  const pane = k.map.createPane('falterPunkte');
  pane.style.zIndex = 450; // ueber Grenzen, unter Markern und Popups
  pane.style.pointerEvents = 'none'; // Tipps gehen an die Karte -> naechster Punkt
  k.map.addControl(new ChipControl());
  k.map.addControl(legende);
  // Ein offenes Popup verschiebt die Karte (autoPan) -> moveend. Wuerde dann neu
  // gezeichnet, verschwaende der Punkt samt Popup sofort wieder. Deshalb warten,
  // bis das Popup zu ist.
  let popupOffen = false; let neuZeichnen = false;
  // Freistehende Popups ("Neuer Fund hier") haben keine Quelle – hasLayer(undefined)
  // wirft in Leaflet und braeche dann das Oeffnen/Schliessen anderer Popups ab
  const istUnseres = (p) => {
    if (p && p === falterPopup) return true;
    const q = p?._source;
    return !!q && rasterLayer.hasLayer(q);
  };
  // Legende unten links wuerde lange Popups ueberdecken -> solange ausblenden
  const legendeSichtbar = (ja) => { if (legende.el) legende.el.style.visibility = ja ? '' : 'hidden'; };
  k.map.on('popupopen', () => legendeSichtbar(false));
  k.map.on('popupclose', () => legendeSichtbar(true));
  k.map.on('popupopen', (e) => { if (istUnseres(e.popup)) popupOffen = true; });
  k.map.on('moveend', () => {
    if (zustand.ansicht === 'funde') return;
    if (popupOffen) { neuZeichnen = true; return; }
    anwenden();
  });
  k.map.on('popupclose', (e) => {
    if (ungenauKreis) { k.map.removeLayer(ungenauKreis); ungenauKreis = null; }
    if (!istUnseres(e.popup)) return;
    popupOffen = false;
    if (neuZeichnen) { neuZeichnen = false; anwenden(); }
  });
  verdrahten();
  await anwenden();
}

function speichern() {
  k.db.einstellungSchreiben('falter', { ...zustand, arten: [...zustand.arten], suche: '' });
}

/**
 * Tipp auf die Karte (aus app.js). true = erledigt, kein "Neuer Fund hier".
 * Knapp neben einer Sichtung (bis ~32 px) oeffnet diese; im reinen
 * Datenbank-Modus wird nie ein neuer Fund angeboten.
 */
export function falterTipp(e) {
  if (!k || zustand.ansicht === 'funde') return false;
  if (k.map.hasLayer(detailLayer) && punkte.length) {
    const z = k.map.getZoom();
    projektion(z);
    const ziel = k.map.project(e.latlng, z);
    let best = -1; let bestD = Infinity;
    const R = punktRadius(z);
    // Neueste zuerst pruefen: bei gleichem Abstand gewinnt der oben gezeichnete Punkt
    for (let j = punkte.length - 1; j >= 0; j--) {
      const dx = projX[j] - ziel.x; const dy = projY[j] - ziel.y;
      const grenze = 32 + stapelRadius(R, punkte[j].eintraege.length) - R;
      const d = dx * dx + dy * dy;
      if (d < grenze * grenze && d < bestD) { best = j; bestD = d; }
    }
    if (best >= 0) { sichtungOeffnen(best); return true; }
  }
  return zustand.ansicht === 'datenbank';
}

function ansichtSetzen(ansicht) {
  zustand.ansicht = ansicht;
  speichern();
  anwenden();
}

let anwendenLauf = 0;
async function anwenden() {
  const map = k.map;
  // Spaeterer Aufruf gewinnt: sonst kann ein noch laufendes Neuzeichnen die
  // Datenbank-Punkte wieder einblenden, nachdem schon auf "Meine Funde" gestellt wurde
  const lauf = ++anwendenLauf;
  if (zustand.ansicht === 'datenbank') map.removeLayer(k.cluster); else if (!map.hasLayer(k.cluster)) map.addLayer(k.cluster);
  // Im reinen Datenbank-Modus statt der Fund-Knoepfe ein klarer Weg zurueck
  document.body.classList.toggle('falter-nur-datenbank', zustand.ansicht === 'datenbank');
  chipAktualisieren();
  if (zustand.ansicht === 'funde') {
    map.removeLayer(rasterLayer); map.removeLayer(detailLayer); legendeZeigen(null);
    return;
  }
  try { await datenLaden(); } catch (e) {
    k.toast(`Schmetterlings-Daten nicht verfügbar (${e.message}).`, 5000);
    return;
  }
  if (lauf !== anwendenLauf) return;
  if (map.getZoom() < DETAIL_AB_ZOOM) {
    map.removeLayer(detailLayer);
    rasterZeichnen();
    rasterLayer.addTo(map);
  } else {
    const ergebnis = await detailZeichnen();
    if (lauf !== anwendenLauf || ergebnis === 'abgebrochen') return;
    map.removeLayer(rasterLayer);
    detailLayer.addTo(map);
  }
  chipAktualisieren();
}

// ---------- Uebersicht (Kaestchen) ----------
function stufe(wert, grenzen) {
  let s = 0;
  grenzen.forEach((g, i) => { if (wert >= g) s = i; });
  return s;
}

function rasterZeichnen() {
  rasterLayer.clearLayers();
  const bl = aktiveBloecke();
  const mitArten = zustand.arten.size > 0;
  const grenzen = mitArten ? STUFEN_SICHT : STUFEN_ARTEN;
  const blick = k.map.getBounds().pad(0.3);
  const interaktiv = zustand.ansicht === 'datenbank';
  const { lat0, lng0, dlat, dlng } = raster;
  for (const [r, c, liste] of raster.z) {
    const s = lat0 + r * dlat; const w = lng0 + c * dlng;
    if (s > blick.getNorth() || s + dlat < blick.getSouth() || w > blick.getEast() || w + dlng < blick.getWest()) continue;
    let artenZahl = 0; let sicht = 0;
    for (const [a, ...anz] of liste) {
      if (mitArten && !zustand.arten.has(a)) continue;
      const n = anz.reduce((summe, x, i) => summe + (bl[i] ? x : 0), 0);
      if (n) { artenZahl++; sicht += n; }
    }
    const wert = mitArten ? sicht : artenZahl;
    if (!wert) continue;
    const rect = L.rectangle([[s, w], [s + dlat, w + dlng]], {
      renderer, weight: 0.5, color: '#7f3307', opacity: 0.35,
      fillColor: STUFEN_FARBEN[stufe(wert, grenzen)], fillOpacity: 0.6,
      interactive: interaktiv, bubblingMouseEvents: false,
    });
    if (interaktiv) rect.bindPopup(() => zellePopup(liste, bl, artenZahl, sicht), POPUP);
    rasterLayer.addLayer(rect);
  }
  legendeZeigen(mitArten ? 'sicht' : 'arten');
}

function zellePopup(liste, bl, artenZahl, sicht) {
  const zeilen = liste
    .filter(([a]) => !zustand.arten.size || zustand.arten.has(a))
    .map(([a, ...anz]) => [a, anz.reduce((s, x, i) => s + (bl[i] ? x : 0), 0)])
    .filter(([, n]) => n)
    .sort((x, y) => y[1] - x[1]);
  const el = document.createElement('div');
  el.className = 'pop falter-pop';
  el.innerHTML = `<h4>${artenZahl} Art${artenZahl === 1 ? '' : 'en'} · ${sicht} Sichtung${sicht === 1 ? '' : 'en'}</h4>
    <p class="hinweis">Kästchen ca. 5 × 5 km${zeitText() ? ` · ${k.esc(zeitText())}` : ''}</p>
    <ul class="falter-zelle">${zeilen.slice(0, 8).map(([a, n]) => `<li><span>${k.esc(artName(a))}</span><b>${n}</b></li>`).join('')}</ul>
    ${zeilen.length > 8 ? `<p class="hinweis">… und ${zeilen.length - 8} weitere</p>` : ''}
    <p class="hinweis">Hineinzoomen zeigt die einzelnen Sichtungen.</p>`;
  return el;
}

// ---------- Einzelsichtungen ----------
function bezirkLaden(gkz) {
  if (!bezirkDaten.has(gkz)) {
    bezirkDaten.set(gkz, fetch(`data/falter/b/${gkz}.json`).then((r) => {
      if (!r.ok) throw new Error('fehlt');
      return r.json();
    }).catch((e) => { bezirkDaten.delete(gkz); throw e; }));
  }
  return bezirkDaten.get(gkz);
}

let detailLauf = 0;
async function detailZeichnen() {
  const lauf = ++detailLauf;
  const blick = k.map.getBounds().pad(0.2);
  const vorhanden = new Set(meta.bezirke);
  const gkzs = k.bezirke().features
    .filter((f) => vorhanden.has(f.properties.gkz))
    .filter((f) => {
      const [w, s, o, n] = f.properties.bbox;
      return o >= blick.getWest() && w <= blick.getEast() && n >= blick.getSouth() && s <= blick.getNorth();
    })
    .map((f) => f.properties.gkz);
  const daten = [];
  for (const gkz of gkzs) {
    try { daten.push(await bezirkLaden(gkz)); } catch {
      k.toast('Schmetterlings-Daten für dieses Gebiet sind offline nicht gespeichert.');
    }
  }
  if (lauf !== detailLauf || zustand.ansicht === 'funde') return 'abgebrochen'; // inzwischen weitergeschoben/umgestellt
  const mitArten = zustand.arten.size > 0;
  const neu = [];
  for (const sp of daten) {
    for (let i = 0; i < sp.a.length; i++) {
      if (mitArten && !zustand.arten.has(sp.a[i])) continue;
      const jahr = Number(sp.t[i].slice(0, 4));
      if (jahr < jahrVon() || jahr > jahrBis()) continue;
      if (!blick.contains([sp.y[i], sp.x[i]])) continue;
      neu.push({ sp, i, jahr });
    }
  }
  const stellen = new Map();
  for (const e of neu) {
    const key = `${e.sp.y[e.i]},${e.sp.x[e.i]}`;
    let st = stellen.get(key);
    if (!st) { st = { y: e.sp.y[e.i], x: e.sp.x[e.i], eintraege: [], jahr: 0 }; stellen.set(key, st); }
    st.eintraege.push(e);
    if (e.jahr > st.jahr) st.jahr = e.jahr;
  }
  punkte = [...stellen.values()].sort((a, b) => a.jahr - b.jahr);
  for (const st of punkte) {
    st.b = BLOECKE.reduce((acc, start, j) => (st.jahr >= start ? j : acc), 0);
    st.eintraege.sort((a, b) => b.jahr - a.jahr || b.sp.t[b.i].localeCompare(a.sp.t[a.i]));
  }
  projZoom = null;
  detailLayer.redraw();
  legendeZeigen('punkte');
  return 'ok';
}

function sichtungOeffnen(j) {
  const st = punkte[j];
  if (st.eintraege.length === 1) { einzelOeffnen(st.eintraege[0]); return; }
  popupZeigen([st.y, st.x], stapelPopup(st), st.eintraege[0]);
}

function einzelOeffnen(e) {
  popupZeigen([e.sp.y[e.i], e.sp.x[e.i]], sichtungPopup(e.sp, e.i), e);
}

function popupZeigen(ll, inhalt, e) {
  if (ungenauKreis) k.map.removeLayer(ungenauKreis);
  // falterPopup wird vor openOn ersetzt: das dabei geschlossene alte Popup gilt dann
  // nicht mehr als "unseres" und loest beim Wechsel Liste -> Einzelsichtung kein Neuzeichnen aus
  falterPopup = L.popup({ ...POPUP, offset: [0, -punktRadius(k.map.getZoom())] }).setLatLng(ll).setContent(inhalt);
  falterPopup.openOn(k.map);
  const u = e.sp.u[e.i];
  const b = BLOECKE.reduce((acc, start, j) => (e.jahr >= start ? j : acc), 0);
  ungenauKreis = u ? L.circle(ll, {
    radius: u, color: BLOCK_FARBEN[b], weight: 1.5, fillOpacity: 0.08, interactive: false,
  }).addTo(k.map) : null;
}

function stapelPopup(st) {
  const jeArt = new Map(); // Art -> { n, von, bis, neueste }
  for (const e of st.eintraege) {
    const a = e.sp.a[e.i];
    const g = jeArt.get(a) || { n: 0, von: e.jahr, bis: e.jahr, neueste: e };
    g.n++; g.von = Math.min(g.von, e.jahr); g.bis = Math.max(g.bis, e.jahr);
    jeArt.set(a, g);
  }
  const zeilen = [...jeArt.entries()].sort((x, y) => y[1].n - x[1].n);
  const jahre = st.eintraege.map((e) => e.jahr);
  const u = Math.max(...st.eintraege.map((e) => e.sp.u[e.i] || 0));
  const el = document.createElement('div');
  el.className = 'pop falter-pop';
  el.innerHTML = `
    <span class="typ" style="background:#b8510c">🦋 Datenbank</span>
    <h4>${st.eintraege.length.toLocaleString('de-AT')} Sichtungen an dieser Stelle</h4>
    <p class="hinweis">${zeilen.length} Art${zeilen.length === 1 ? '' : 'en'} · ${Math.min(...jahre)}–${Math.max(...jahre)}${u ? ` · Ortsangabe ± ${u.toLocaleString('de-AT')} m` : ''}</p>
    <ul class="falter-stapel">${zeilen.slice(0, 30).map(([a, g], idx) => `
      <li><button type="button" data-z="${idx}">
        <span>${k.esc(artName(a))}</span>
        <small>${g.n}× · ${g.von === g.bis ? g.von : `${g.von}–${g.bis}`}</small>
      </button></li>`).join('')}</ul>
    ${zeilen.length > 30 ? `<p class="hinweis">… und ${zeilen.length - 30} weitere Arten</p>` : ''}
    <p class="hinweis">Gleiche Koordinate bei mehreren Meldungen – oft Sammelangaben mit ungefährem Fundort. Antippen zeigt die neueste Sichtung der Art.</p>`;
  el.querySelector('.falter-stapel').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button'); if (!btn) return;
    einzelOeffnen(zeilen[Number(btn.dataset.z)][1].neueste);
  });
  return el;
}

// GBIF schreibt Lizenzen je nach Abrufweg als URL oder als "CC_BY_NC_4_0"
function lizenzText(l) {
  const m = /^CC(0)?_?(BY)?_?(NC|SA|ND)?_?(\d)_(\d)$/i.exec(l || '');
  if (!m) return l;
  return m[1] ? 'CC0' : `CC ${m[2]}${m[3] ? `-${m[3]}` : ''} ${m[4]}.${m[5]}`;
}

function datumText(t) {
  const [j, m, d] = t.split('-');
  return d ? `${d}.${m}.${j}` : (m ? `${m}/${j}` : j);
}

function sichtungPopup(sp, i) {
  const a = arten[sp.a[i]];
  const quellen = sp.q[i].map((q) => meta.quellen[q]);
  const el = document.createElement('div');
  el.className = 'pop falter-pop';
  el.innerHTML = `
    <span class="typ" style="background:#b8510c">🦋 Datenbank</span>
    <h4>${k.esc(a.d || a.w)}</h4>
    ${a.d ? `<p class="wiss">${k.esc(a.w)}</p>` : ''}
    <dl>
      <dt>Datum</dt><dd>${k.esc(datumText(sp.t[i]))}</dd>
      <dt>Genauigkeit</dt><dd>${sp.u[i] ? `± ${sp.u[i].toLocaleString('de-AT')} m` : 'nicht angegeben'}</dd>
      <dt>Quelle${quellen.length > 1 ? 'n' : ''}</dt><dd>${quellen.map((q) => `${k.esc(q.name)} <small>(${k.esc(lizenzText(q.lizenz))})</small>`).join('<br>')}</dd>
    </dl>
    ${sp.n[i] > 1 ? `<p class="hinweis">${sp.n[i]} gleichlautende Meldungen zusammengefasst.</p>` : ''}
    <p><a href="https://www.gbif.org/occurrence/${sp.i[i]}" target="_blank" rel="noopener">Original bei GBIF ansehen ↗</a></p>
    <div class="knoepfe"><button data-a="nur">Nur diese Art zeigen</button></div>`;
  el.querySelector('[data-a=nur]').onclick = () => {
    zustand.arten = new Set([sp.a[i]]); speichern(); k.map.closePopup(); anwenden();
  };
  return el;
}

// ---------- Legende & Chip ----------
const LegendeControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    this.el = L.DomUtil.create('div', 'falter-legende');
    this.el.hidden = true;
    L.DomEvent.disableClickPropagation(this.el);
    return this.el;
  },
});
const legende = new LegendeControl();

function legendeZeigen(art) {
  const el = legende.el;
  if (!el) return;
  el.hidden = !art;
  if (!art) return;
  if (art === 'punkte') {
    el.innerHTML = `<b>Sichtung aus</b>${BLOCK_NAMEN.map((n, i) => `<span><i style="background:${BLOCK_FARBEN[i]};border-radius:50%"></i>${n}</span>`).join('')}`;
    return;
  }
  const grenzen = art === 'sicht' ? STUFEN_SICHT : STUFEN_ARTEN;
  const titel = art === 'sicht' ? 'Sichtungen je Kästchen' : 'Arten je Kästchen';
  el.innerHTML = `<b>${titel}</b>${grenzen.map((g, i) => {
    const bis = grenzen[i + 1] ? grenzen[i + 1] - 1 : null;
    const text = bis == null ? `${g}+` : (bis === g ? `${g}` : `${g}–${bis}`);
    return `<span><i style="background:${STUFEN_FARBEN[i]}"></i>${text}</span>`;
  }).join('')}`;
}

let chip = null;
const ChipControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    chip = L.DomUtil.create('button', 'falter-chip');
    chip.type = 'button';
    L.DomEvent.disableClickPropagation(chip);
    L.DomEvent.on(chip, 'click', () => k.panelOeffnen('panelFalter'));
    return chip;
  },
});

function zeitText() {
  const { von, bis } = zustand;
  if (von == null && bis == null) return '';
  if (bis == null) return `ab ${von}`;
  if (von == null) return `bis ${bis}`;
  return von === bis ? `${von}` : `${von}–${bis}`;
}

function chipAktualisieren() {
  if (!chip) return;
  chip.hidden = zustand.ansicht === 'funde';
  const artText = zustand.arten.size === 0 ? 'alle Arten'
    : (zustand.arten.size === 1 ? artName([...zustand.arten][0]) : `${zustand.arten.size} Arten`);
  chip.textContent = `🦋 ${artText}${zeitText() ? ` · ${zeitText()}` : ''}`;
}

// ---------- Panel ----------
function artZaehlung() {
  // Sichtungen je Art im gewaehlten Zeitraum (blockgenau, aus der Uebersicht)
  const bl = aktiveBloecke();
  const z = new Array(arten.length).fill(0);
  for (const [, , liste] of raster.z) {
    for (const [a, ...anz] of liste) z[a] += anz.reduce((s, x, i) => s + (bl[i] ? x : 0), 0);
  }
  return z;
}

export async function panelZeichnen() {
  $$('#falterAnsicht button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ansicht === zustand.ansicht)));
  $('#falterVon').value = zustand.von ?? '';
  $('#falterBis').value = zustand.bis ?? '';
  $('#falterSort').value = zustand.sort;
  $('#falterSuche').value = zustand.suche;
  try { await datenLaden(); } catch (e) {
    $('#falterInfo').textContent = `Daten nicht verfügbar (${e.message}).`;
    return;
  }
  artenZeichnen();
  $('#falterInfo').innerHTML = `Enthalten: <b>${k.esc(meta.gebiete.join(', '))}</b> · ${meta.sichtungen.toLocaleString('de-AT')} Sichtungen
    von ${arten.length} Arten · Stand ${k.esc(meta.stand.split('-').reverse().join('.'))}<br>Quelle: ${k.esc(meta.zitat)}`;
  $('#falterQuellen').innerHTML = meta.quellen.map((q) => `<li>${k.esc(q.name)} <small>(${k.esc(lizenzText(q.lizenz))})</small></li>`).join('');
}

function artenZeichnen() {
  const z = artZaehlung();
  const q = zustand.suche.trim().toLowerCase();
  let liste = arten.map((a, i) => ({ ...a, i, z: z[i] }))
    .filter((a) => !q || `${a.d || ''} ${a.w}`.toLowerCase().includes(q));
  liste.sort(zustand.sort === 'anzahl' ? (x, y) => y.z - x.z : (x, y) => (x.d || x.w).localeCompare(y.d || y.w, 'de'));
  // Gewaehlte Arten immer oben, damit man sie wiederfindet
  liste = [...liste.filter((a) => zustand.arten.has(a.i)), ...liste.filter((a) => !zustand.arten.has(a.i))];
  $('#falterArtZahl').textContent = zustand.arten.size ? `(${zustand.arten.size} gewählt)` : '(alle)';
  $('#falterArten').innerHTML = liste.map((a) => `
    <li class="${a.z ? '' : 'leer'}"><label>
      <input type="checkbox" value="${a.i}" ${zustand.arten.has(a.i) ? 'checked' : ''}>
      <span class="name">${k.esc(a.d || a.w)}${a.d ? `<i>${k.esc(a.w)}</i>` : ''}</span>
      <b>${a.z.toLocaleString('de-AT')}</b>
    </label></li>`).join('') || '<li class="leer">Keine Art gefunden.</li>';
}

function $$(s) { return [...document.querySelectorAll(s)]; }

function verdrahten() {
  $('#btnZurueckFunde').onclick = () => { ansichtSetzen('funde'); k.map.closePopup(); };
  $('#falterAnsicht').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    zustand.ansicht = b.dataset.ansicht; speichern(); panelZeichnen(); anwenden();
  };
  const jahr = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  $('#falterVon').onchange = (e) => { zustand.von = jahr(e.target.value); speichern(); artenZeichnen(); anwenden(); };
  $('#falterBis').onchange = (e) => { zustand.bis = jahr(e.target.value); speichern(); artenZeichnen(); anwenden(); };
  $('#falterZeitSchnell').onclick = (e) => {
    const z = e.target.closest('button')?.dataset.zeit; if (z == null) return;
    zustand.bis = null;
    zustand.von = z === 'alle' ? null : (z === '5' ? new Date().getFullYear() - 4 : Number(z));
    speichern(); panelZeichnen(); anwenden();
  };
  $('#falterSuche').oninput = (e) => { zustand.suche = e.target.value; artenZeichnen(); };
  $('#falterSort').onchange = (e) => { zustand.sort = e.target.value; speichern(); artenZeichnen(); };
  $('#falterArten').onchange = (e) => {
    const i = Number(e.target.value);
    if (e.target.checked) zustand.arten.add(i); else zustand.arten.delete(i);
    // Wer eine Art waehlt, will sie sehen – aus "Meine Funde" automatisch umschalten
    if (zustand.arten.size && zustand.ansicht === 'funde') zustand.ansicht = 'datenbank';
    speichern();
    $('#falterArtZahl').textContent = zustand.arten.size ? `(${zustand.arten.size} gewählt)` : '(alle)';
    $$('#falterAnsicht button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ansicht === zustand.ansicht)));
    anwenden();
  };
  $('#falterAuswahlWeg').onclick = () => { zustand.arten.clear(); speichern(); artenZeichnen(); anwenden(); };
}
