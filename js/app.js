/* global L */
import * as db from './db.js';
import { bezirkeLaden, bezirkFinden, gemeindenLaden, ortBestimmen } from './geo.js';
import * as offline from './offline.js';
import { alsGradMinSek, koordinatenAusText } from './erkennung.js';
import { bildAuswerten, dateiSchluessel } from './nachtrag.js';
import { falterStarten, falterTipp, panelZeichnen as falterPanelZeichnen } from './falter.js';

const VERSION = '1.3.2'; // sichtbar unter „Mehr“ – bei Updates mit sw.js-VERSION mitziehen

// ---------- Stammdaten ----------
const TYPEN = {
  Pflanze: { farbe: '#3f7d3a', icon: '🌿' },
  Vogel: { farbe: '#2f6ea8', icon: '🐦' },
  Säugetier: { farbe: '#8a5a35', icon: '🦊' },
  Insekt: { farbe: '#c98417', icon: '🦋' },
  Amphibie: { farbe: '#24877e', icon: '🐸' },
  Reptil: { farbe: '#7a7a1c', icon: '🦎' },
  Sonstiges: { farbe: '#7a4f8f', icon: '🐾' },
};
const GRUPPEN = ['Vogel', 'Säugetier', 'Insekt', 'Amphibie', 'Reptil', 'Sonstiges'];
const LEBENSRAEUME = [
  'Wald', 'Waldrand', 'Wiese', 'Trockenrasen', 'Acker', 'Weingarten', 'Obstgarten',
  'Hecke / Gebüsch', 'Gewässer', 'Feuchtgebiet / Moor', 'Fels / Steinbruch',
  'Siedlung / Garten', 'Wegrand / Straßenrand', 'Sonstiges',
];
const MONATE = ['Jän', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const GEMEINDEN_AB_ZOOM = 10;

const typKey = (f) => (f.kategorie === 'Pflanze' ? 'Pflanze' : (TYPEN[f.gruppe] ? f.gruppe : 'Sonstiges'));
const typ = (f) => TYPEN[typKey(f)];

// ---------- Hilfen ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const lokalJetzt = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const datumText = (s) => { if (!s) return ''; const [d, t] = s.split('T'); const [y, m, dd] = d.split('-'); return `${dd}.${m}.${y}${t ? `, ${t.slice(0, 5)}` : ''}`; };
const kurzBezirk = (n) => (n || '').replace(/^Bezirk\s+/, '');

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

function datei(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- Zustand ----------
let funde = [];
let bezirke = null;
let modus = null; // {art:'neu'} | {art:'verschieben', id}
let bearbeitung = null; // {fund, istNeu, neuesFoto, fotoEntfernt}
let letzteKategorie = { kategorie: 'Pflanze', gruppe: null };
const filter = { typen: new Set(Object.keys(TYPEN)), art: '', von: '', bis: '', lebensraeume: new Set(), suche: '' };

// ---------- Karte ----------
const map = L.map('map', { zoomControl: true, maxZoom: 19, minZoom: 6 }).setView([47.73, 16.40], 11);
map.attributionControl.setPrefix(false);

const grundkarten = Object.fromEntries(offline.EBENEN.map((e) => [e.id, L.tileLayer(e.url, {
  maxZoom: e.maxZoom, maxNativeZoom: e.maxNativeZoom, subdomains: e.subdomains || 'abc', attribution: e.attribution,
})]));
let aktiveEbene = null;
// Zuletzt genutzte Nicht-Satelliten-Karte: dorthin springt der Umschaltknopf zurück
let letzteKarte = 'osm';
function ebeneSetzen(id) {
  if (!grundkarten[id]) id = 'osm';
  if (aktiveEbene) map.removeLayer(grundkarten[aktiveEbene]);
  grundkarten[id].addTo(map).bringToBack();
  aktiveEbene = id;
  db.einstellungSchreiben('ebene', id);
  if (id !== 'ortho') { letzteKarte = id; db.einstellungSchreiben('karte', id); }
  bezirkeLayer.setStyle(grenzStil('bezirk'));
  gemeindenJe.forEach((l) => l.setStyle(grenzStil('gemeinde')));
  umschaltKnopfAktualisieren();
}

// Ein Tipp: Satellit <-> Karte. Draussen der haeufigste Wechsel, daher direkt auf der Karte.
let umschaltKnopf = null;
const UmschaltControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    umschaltKnopf = L.DomUtil.create('button', 'umschalt-knopf');
    umschaltKnopf.type = 'button';
    L.DomEvent.disableClickPropagation(umschaltKnopf);
    L.DomEvent.on(umschaltKnopf, 'click', () => ebeneSetzen(aktiveEbene === 'ortho' ? letzteKarte : 'ortho'));
    umschaltKnopfAktualisieren();
    return umschaltKnopf;
  },
});
function umschaltKnopfAktualisieren() {
  if (!umschaltKnopf) return;
  const satellit = aktiveEbene === 'ortho';
  umschaltKnopf.innerHTML = satellit ? '<span>🗺️</span>Karte' : '<span>🛰️</span>Satellit';
  umschaltKnopf.title = satellit ? 'Zur Karte wechseln' : 'Zum Satellitenbild wechseln';
  umschaltKnopf.classList.toggle('auf-satellit', satellit);
}
map.addControl(new UmschaltControl());

// Grenzen auf Canvas: tausende Linien als SVG machen das Verschieben am Handy zaeh
const grenzRenderer = L.canvas({ padding: 0.3 });
function grenzStil(art) {
  // Auf dem Luftbild verschwinden dunkle Linien: dort helle Grenzfarben
  const hell = aktiveEbene === 'ortho';
  return art === 'bezirk'
    ? { color: hell ? '#f0c24b' : '#234a2c', weight: 2.2, opacity: .8, fill: false }
    : { color: hell ? '#ffffff' : '#2f5d3a', weight: 1.8, opacity: .9, fill: false, dashArray: '7 5' };
}
const bezirkeLayer = L.geoJSON(null, { renderer: grenzRenderer, interactive: false, style: () => grenzStil('bezirk') });
const gemeindenLayer = L.layerGroup();
const gemeindenJe = new Map(); // gkz -> L.GeoJSON, nur fuer Bezirke im Blickfeld

const cluster = L.markerClusterGroup({
  showCoverageOnHover: false, maxClusterRadius: 45, spiderfyOnMaxZoom: true, disableClusteringAtZoom: 18,
  iconCreateFunction: (c) => {
    const n = c.getChildCount();
    return L.divIcon({ html: `<div>${n}</div>`, className: `cluster${n >= 20 ? ' gross' : ''}`, iconSize: [50, 50] });
  },
}).addTo(map);

// Eigene Kartenknöpfe: Standort zeigen
const KnopfControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const bar = L.DomUtil.create('div', 'leaflet-bar');
    const a = L.DomUtil.create('a', 'kartenknopf', bar);
    a.href = '#'; a.title = 'Meinen Standort zeigen'; a.setAttribute('role', 'button'); a.textContent = '◎';
    L.DomEvent.on(a, 'click', (e) => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); standortZeigen(); });
    const b = L.DomUtil.create('a', 'kartenknopf', bar);
    b.href = '#'; b.title = 'Kartenansicht'; b.setAttribute('role', 'button'); b.textContent = '🗺';
    L.DomEvent.on(b, 'click', (e) => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); panelOeffnen('panelEbenen'); });
    return bar;
  },
});
map.addControl(new KnopfControl());

let standortMarker = null; let standortKreis = null;
function standortAnzeigen(lat, lng, gen) {
  const ll = [lat, lng];
  if (!standortMarker) {
    standortMarker = L.marker(ll, { icon: L.divIcon({ className: 'standort-punkt', iconSize: [18, 18] }), interactive: false, keyboard: false }).addTo(map);
    standortKreis = L.circle(ll, { radius: gen, interactive: false, color: '#2b7de9', weight: 1, fillOpacity: .1 }).addTo(map);
  } else {
    standortMarker.setLatLng(ll); standortKreis.setLatLng(ll).setRadius(gen);
  }
}

function position() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('Dieses Gerät kann keinen Standort liefern.')); return; }
    if (!window.isSecureContext) { reject(new Error('Standort geht nur über eine https-Adresse.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(p.coords),
      (e) => reject(new Error({
        1: 'Standortzugriff wurde nicht erlaubt. Bitte in den Browser-Einstellungen freigeben.',
        2: 'Standort nicht verfügbar – GPS eingeschaltet?',
        3: 'Standort hat zu lange gedauert. Bitte nochmal versuchen (am besten im Freien).',
      }[e.code] || e.message)),
      { enableHighAccuracy: true, timeout: 25000, maximumAge: 10000 },
    );
  });
}

async function standortZeigen() {
  toast('Standort wird ermittelt …', 30000);
  try {
    const c = await position();
    standortAnzeigen(c.latitude, c.longitude, c.accuracy);
    map.setView([c.latitude, c.longitude], Math.max(map.getZoom(), 16));
    toast(`Genauigkeit ± ${Math.round(c.accuracy)} m`);
  } catch (e) { toast(e.message, 5000); }
}

// ---------- Marker & Popups ----------
function markerIcon(f) {
  const t = typ(f);
  return L.divIcon({
    className: 'fund-marker', html: `<div style="background:${t.farbe}"><span>${t.icon}</span></div>`,
    iconSize: [34, 34], iconAnchor: [17, 40], popupAnchor: [0, -36],
  });
}

const markerVon = new Map();

function popupInhalt(f) {
  const t = typ(f);
  const el = document.createElement('div');
  el.className = 'pop';
  const ort = [f.gemeinde, kurzBezirk(f.bezirk)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  el.innerHTML = `
    <span class="typ" style="background:${t.farbe}">${t.icon} ${esc(typKey(f))}</span>
    <h4>${esc(f.art)}</h4>
    ${f.wiss ? `<p class="wiss">${esc(f.wiss)}</p>` : ''}
    <div class="foto"></div>
    <dl>
      <dt>Datum</dt><dd>${esc(datumText(f.datum))}</dd>
      ${f.anzahl ? `<dt>Anzahl</dt><dd>${esc(f.anzahl)}</dd>` : ''}
      ${f.lebensraum ? `<dt>Lebensraum</dt><dd>${esc(f.lebensraum)}</dd>` : ''}
      ${ort ? `<dt>Ort</dt><dd>${esc(ort)}</dd>` : ''}
      <dt>Position</dt><dd>${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}${f.genauigkeit ? ` (± ${Math.round(f.genauigkeit)} m)` : ''}</dd>
    </dl>
    ${f.notiz ? `<div class="notiz">${esc(f.notiz)}</div>` : ''}
    <div class="knoepfe">
      <button data-a="bearbeiten">✎ Bearbeiten</button>
      <button data-a="verschieben">✥ Verschieben</button>
      <button data-a="loeschen" class="gefahr">🗑</button>
    </div>`;
  if (f.fotoId) {
    db.fotoLaden(f.fotoId).then((blob) => {
      if (!blob) return;
      const img = document.createElement('img');
      img.src = URL.createObjectURL(blob); img.alt = f.art;
      img.onload = () => markerVon.get(f.id)?.getPopup()?.update();
      img.onclick = () => fotoGross(img.src);
      $('.foto', el).append(img);
    });
  }
  el.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a) return;
    map.closePopup();
    if (a === 'bearbeiten') formularOeffnen(f, false);
    if (a === 'verschieben') verschiebenStarten(f);
    if (a === 'loeschen') fundLoeschenFragen(f);
  });
  return el;
}

function fotoGross(src) {
  const d = document.createElement('div');
  d.className = 'foto-gross';
  d.innerHTML = `<img src="${src}" alt="">`;
  d.onclick = () => d.remove();
  document.body.append(d);
}

function gefiltert() {
  const q = filter.suche.trim().toLowerCase();
  return funde.filter((f) => {
    if (!filter.typen.has(typKey(f))) return false;
    if (filter.art && f.art !== filter.art) return false;
    if (q && !(`${f.art} ${f.wiss || ''}`.toLowerCase().includes(q))) return false;
    const d = (f.datum || '').slice(0, 10);
    if (filter.von && d < filter.von) return false;
    if (filter.bis && d > filter.bis) return false;
    if (filter.lebensraeume.size && !filter.lebensraeume.has(f.lebensraum)) return false;
    return true;
  });
}

function filterAnzahl() {
  return (filter.typen.size < Object.keys(TYPEN).length) + !!filter.art + !!(filter.von || filter.bis)
    + (filter.lebensraeume.size > 0) + !!filter.suche.trim();
}

function aktualisieren() {
  const sichtbar = gefiltert();
  cluster.clearLayers();
  markerVon.clear();
  const ms = sichtbar.map((f) => {
    const m = L.marker([f.lat, f.lng], { icon: markerIcon(f), title: f.art });
    // Inhalt je Oeffnung nur einmal bauen: update() nach dem Foto-Laden ruft die
    // Funktion erneut auf und wuerde sonst ein neues, ungeladenes Bild erzeugen.
    let inhalt = null;
    m.bindPopup(() => (inhalt ||= popupInhalt(f)), {
      maxWidth: 300, minWidth: 230, autoPanPaddingTopLeft: [64, 76], autoPanPaddingBottomRight: [12, 96],
    });
    m.on('popupclose', () => { inhalt = null; });
    markerVon.set(f.id, m);
    return m;
  });
  cluster.addLayers(ms);
  const n = filterAnzahl();
  $('#filterBadge').hidden = !n; $('#filterBadge').textContent = n;
  const offen = history.state?.panel;
  if (offen === 'panelListe') listeZeichnen();
  if (offen === 'panelStatistik') statistikZeichnen();
  artenListeFuellen();
}

// ---------- Erfassen ----------
let neuPopup = null;
let popupZuZeit = 0;
// Zielkreis: zeigt beim Antippen genau, wohin der Fund kommt (die Popup-Spitze allein ist zu ungenau)
const zielKreis = L.marker([0, 0], {
  icon: L.divIcon({ className: 'tipp-ziel', html: '<i></i>', iconSize: [36, 36], iconAnchor: [18, 18] }),
  interactive: false, keyboard: false,
});
map.on('popupclose', (e) => {
  popupZuZeit = Date.now();
  if (e.popup === neuPopup) zielKreis.remove();
});

map.on('click', async (e) => {
  const { lat, lng } = e.latlng;
  if (modus?.art === 'neu') {
    modusBeenden();
    formularOeffnen(neuerFund(lat, lng), true);
    return;
  }
  if (modus?.art === 'verschieben') {
    const f = funde.find((x) => x.id === modus.id);
    modusBeenden();
    if (f) await fundVerschieben(f, lat, lng);
    return;
  }
  // Ein Tipp, der nur ein offenes Popup schliesst, soll keinen neuen Fund anbieten
  if (Date.now() - popupZuZeit < 400) return;
  // Schmetterlings-Datenbank: knapp daneben getippt -> naechste Sichtung oeffnen;
  // im reinen Datenbank-Modus nie einen neuen Fund anbieten
  if (falterTipp(e)) return;
  const el = document.createElement('div');
  el.className = 'pop-neu';
  el.innerHTML = `<p class="ort">…</p>
    <div class="pop-neu-knoepfe">
      <button class="btn" data-a="neu">＋ Neuer Fund hier</button>
      <button class="btn btn-hell" data-a="weg">Abbrechen</button>
    </div>`;
  $('[data-a=neu]', el).onclick = () => { map.closePopup(); formularOeffnen(neuerFund(lat, lng), true); };
  $('[data-a=weg]', el).onclick = () => map.closePopup();
  zielKreis.setLatLng(e.latlng).addTo(map);
  neuPopup = L.popup({ minWidth: 200, offset: [0, -14] }).setLatLng(e.latlng).setContent(el).openOn(map);
  const o = await ortBestimmen(lat, lng);
  $('.ort', el).textContent = o.gemeinde ? `${o.gemeinde} · ${kurzBezirk(o.bezirk)}` : (o.bezirk ? kurzBezirk(o.bezirk) : `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  neuPopup.update();
});

function neuerFund(lat, lng, genauigkeit = null) {
  return {
    id: db.neueId(), kategorie: letzteKategorie.kategorie, gruppe: letzteKategorie.gruppe,
    art: '', wiss: '', datum: lokalJetzt(), anzahl: '', lebensraum: '', notiz: '',
    lat, lng, genauigkeit, fotoId: null, gemeinde: null, bezirk: null,
  };
}

function modusStarten(m, text) {
  modus = m;
  $('#bannerText').textContent = text;
  $('#banner').hidden = false;
  document.body.classList.add('karte-modus');
}
function modusBeenden() {
  modus = null;
  $('#banner').hidden = true;
  document.body.classList.remove('karte-modus');
}
$('#bannerAbbrechen').onclick = modusBeenden;

$('#btnKartenFund').onclick = () => modusStarten({ art: 'neu' }, 'Tippe auf die Fundstelle');
$('#btnStandortFund').onclick = async () => {
  toast('Standort wird ermittelt …', 30000);
  try {
    const c = await position();
    standortAnzeigen(c.latitude, c.longitude, c.accuracy);
    map.setView([c.latitude, c.longitude], Math.max(map.getZoom(), 16));
    $('#toast').hidden = true;
    formularOeffnen(neuerFund(c.latitude, c.longitude, c.accuracy), true);
  } catch (e) { toast(e.message, 5000); }
};

function verschiebenStarten(f) {
  modusStarten({ art: 'verschieben', id: f.id }, `Neue Position für „${f.art}“ antippen`);
}

async function fundVerschieben(f, lat, lng) {
  const o = await ortBestimmen(lat, lng);
  const neu = { ...f, lat, lng, genauigkeit: null, ...o, geaendert: new Date().toISOString() };
  await db.fundSpeichern(neu);
  funde = funde.map((x) => (x.id === f.id ? neu : x));
  aktualisieren();
  toast('Fund verschoben');
}

async function fundLoeschenFragen(f) {
  if (!confirm(`Fund „${f.art}“ vom ${datumText(f.datum)} wirklich löschen?`)) return;
  await db.fundLoeschen(f.id);
  if (f.fotoId) await db.fotoLoeschen(f.fotoId);
  funde = funde.filter((x) => x.id !== f.id);
  aktualisieren();
  toast('Fund gelöscht');
}

// ---------- Formular ----------
const fSel = {
  art: $('#fArt'), wiss: $('#fWiss'), datum: $('#fDatum'), anzahl: $('#fAnzahl'),
  lebensraum: $('#fLebensraum'), notiz: $('#fNotiz'), foto: $('#fFoto'),
};
fSel.lebensraum.innerHTML = '<option value="">– bitte wählen –</option>' + LEBENSRAEUME.map((l) => `<option>${esc(l)}</option>`).join('');
$('#gruppenWahl').innerHTML = GRUPPEN.map((g) => `<button type="button" data-gruppe="${esc(g)}">${TYPEN[g].icon} ${esc(g)}</button>`).join('');

function katAnzeigen() {
  const f = bearbeitung.fund;
  $$('.kat').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kat === f.kategorie)));
  $('#gruppenWahl').hidden = f.kategorie !== 'Tier';
  $$('#gruppenWahl button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.gruppe === f.gruppe)));
}
$$('.kat').forEach((b) => { b.onclick = () => { bearbeitung.fund.kategorie = b.dataset.kat; if (b.dataset.kat === 'Pflanze') bearbeitung.fund.gruppe = null; katAnzeigen(); }; });
$('#gruppenWahl').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  bearbeitung.fund.gruppe = b.dataset.gruppe; katAnzeigen();
};

async function formularOeffnen(fund, istNeu) {
  bearbeitung = { fund: { ...fund }, istNeu, neuesFoto: null, fotoEntfernt: false };
  $('#formTitel').textContent = nachtrag ? 'Fund nachtragen' : (istNeu ? 'Neuer Fund' : 'Fund bearbeiten');
  $('#nachtragKopf').hidden = !nachtrag;
  $('#ntUeberspringen').hidden = !nachtrag;
  $('#formAbbrechen').textContent = nachtrag ? 'Beenden' : 'Abbrechen';
  $('#formSpeichern').textContent = nachtrag ? 'Speichern & weiter' : 'Speichern';
  fSel.art.value = fund.art || ''; fSel.wiss.value = fund.wiss || '';
  fSel.datum.value = fund.datum || lokalJetzt(); fSel.anzahl.value = fund.anzahl || '';
  fSel.lebensraum.value = fund.lebensraum || ''; fSel.notiz.value = fund.notiz || '';
  fSel.foto.value = '';
  $('#formLoeschen').hidden = istNeu;
  katAnzeigen();
  fotoVorschau(null);
  if (fund.fotoId) fotoVorschau(await db.fotoLaden(fund.fotoId));
  positionAnzeigen();
  panelOeffnen('panelFormular');
  if (istNeu && !matchMedia('(pointer: coarse)').matches) fSel.art.focus();
}

async function positionAnzeigen() {
  const f = bearbeitung.fund;
  const el = $('#fPosition');
  if (f.lat == null) { el.textContent = '📍 Noch keine Position'; return; }
  const basis = `📍 ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}${f.genauigkeit ? ` · ± ${Math.round(f.genauigkeit)} m` : ''}`;
  el.textContent = basis;
  if (!f.bezirk || bearbeitung.istNeu) {
    const lat = f.lat; const lng = f.lng;
    const o = await ortBestimmen(lat, lng);
    // Inzwischen verschoben (Nachtragen-Karte)? Dann gehoert das Ergebnis nicht mehr hierher.
    if (bearbeitung?.fund !== f || f.lat !== lat || f.lng !== lng) return;
    Object.assign(f, o);
  }
  const ort = [f.gemeinde, kurzBezirk(f.bezirk)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  el.textContent = ort ? `${basis} · ${ort}` : basis;
}

let vorschauUrl = null;
function fotoVorschau(blob) {
  if (vorschauUrl) URL.revokeObjectURL(vorschauUrl);
  vorschauUrl = blob ? URL.createObjectURL(blob) : null;
  $('#fotoVorschau').hidden = !blob;
  if (blob) $('#fotoVorschau').src = vorschauUrl;
  $('#fotoEntfernen').hidden = !blob;
}

// Fotos verkleinern: Handyfotos haben 3–8 MB, so werden es ~200–300 KB.
async function fotoVerkleinern(file, max = 1400) {
  let bild;
  try { bild = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
    bild = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
  const w = bild.width; const h = bild.height;
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(bild, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}

fSel.foto.onchange = async () => {
  const file = fSel.foto.files[0];
  if (!file) return;
  toast('Foto wird vorbereitet …');
  try {
    const blob = await fotoVerkleinern(file);
    bearbeitung.neuesFoto = blob; bearbeitung.fotoEntfernt = false;
    fotoVorschau(blob);
    $('#toast').hidden = true;
  } catch { toast('Dieses Foto konnte nicht gelesen werden.', 4000); }
};
$('#fotoEntfernen').onclick = () => { bearbeitung.neuesFoto = null; bearbeitung.fotoEntfernt = true; fotoVorschau(null); fSel.foto.value = ''; };

// Bekannte Art gewählt: wissenschaftlichen Namen und Kategorie vom letzten Fund übernehmen
fSel.art.addEventListener('change', () => {
  const bekannt = [...funde].reverse().find((f) => f.art.toLowerCase() === fSel.art.value.trim().toLowerCase());
  if (!bekannt) return;
  if (!fSel.wiss.value && bekannt.wiss) fSel.wiss.value = bekannt.wiss;
  if (bearbeitung.istNeu) { bearbeitung.fund.kategorie = bekannt.kategorie; bearbeitung.fund.gruppe = bekannt.gruppe; katAnzeigen(); }
});

$('#formular').onsubmit = async (e) => {
  e.preventDefault();
  const b = bearbeitung;
  const art = fSel.art.value.trim();
  if (!art) { toast('Bitte einen Artnamen eingeben.'); fSel.art.focus(); return; }
  if (b.fund.lat == null) { toast('Bitte zuerst die Fundstelle auf der kleinen Karte antippen.', 4000); $('#ntKarte').scrollIntoView({ block: 'center' }); return; }
  if (b.fund.kategorie === 'Tier' && !b.fund.gruppe) b.fund.gruppe = 'Sonstiges';
  const jetzt = new Date().toISOString();
  const f = {
    ...b.fund, art, wiss: fSel.wiss.value.trim(), datum: fSel.datum.value || lokalJetzt(),
    anzahl: fSel.anzahl.value.trim(), lebensraum: fSel.lebensraum.value, notiz: fSel.notiz.value.trim(),
    erstellt: b.fund.erstellt || jetzt, geaendert: jetzt,
  };
  if (b.neuesFoto) {
    f.fotoId = f.fotoId || db.neueId();
    await db.fotoSpeichern(f.fotoId, b.neuesFoto);
  } else if (b.fotoEntfernt && f.fotoId) {
    await db.fotoLoeschen(f.fotoId); f.fotoId = null;
  }
  if (!f.bezirk || nachtrag) Object.assign(f, await ortBestimmen(f.lat, f.lng));
  if (nachtrag) f.importKey = nachtrag.eintraege[nachtrag.index].schluessel;
  await db.fundSpeichern(f);
  const i = funde.findIndex((x) => x.id === f.id);
  if (i >= 0) funde[i] = f; else funde.push(f);
  letzteKategorie = { kategorie: f.kategorie, gruppe: f.gruppe };
  bearbeitung = null;
  if (nachtrag) {
    nachtrag.gespeichert++;
    toast(`„${f.art}“ gespeichert`, 1500);
    nachtragWeiter();
    if (funde.length === 1) db.dauerhaftAnfordern();
    return;
  }
  panelSchliessen();
  aktualisieren();
  toast(b.istNeu ? `„${f.art}“ gespeichert` : 'Änderungen gespeichert');
  if (funde.length === 1) db.dauerhaftAnfordern();
};
$('#formLoeschen').onclick = async () => {
  const f = funde.find((x) => x.id === bearbeitung?.fund.id);
  if (!f) return;
  panelSchliessen();
  await fundLoeschenFragen(f);
};

// ---------- Alte Funde nachtragen ----------
// Viele Bilder auf einmal: Auswertung laeuft der Reihe nach im Hintergrund,
// waehrend man die bereits ausgewerteten schon durchgeht.
let nachtrag = null; // { eintraege: [{file, schluessel, p, erg}], index, gespeichert, uebersprungen, bereits, fertig }
let ntBildUrl = null;
let ntKarte = null; let ntMarker = null; let ntEbene = null;

$('#ntDateien').onchange = (e) => {
  const dateien = [...e.target.files];
  e.target.value = '';
  if (dateien.length) nachtragStarten(dateien);
};

function nachtragStarten(dateien) {
  const vorhanden = new Set(funde.map((f) => f.importKey).filter(Boolean));
  const neu = dateien.filter((d) => !vorhanden.has(dateiSchluessel(d)));
  const bereits = dateien.length - neu.length;
  if (!neu.length) { toast(`Alle ${dateien.length} Bilder wurden schon nachgetragen.`, 4000); return; }
  const lauf = { eintraege: [], index: 0, gespeichert: 0, uebersprungen: 0, bereits, fertig: 0 };
  let kette = Promise.resolve();
  for (const file of neu) {
    const eintrag = { file, schluessel: dateiSchluessel(file), erg: null };
    eintrag.p = kette = kette
      .then(() => (nachtrag === lauf ? bildAuswerten(file) : null))
      .catch((err) => ({ lat: null, lng: null, ortQuelle: null, datum: null, istFoto: true, hinweis: `Bild nicht lesbar (${err?.message ?? err}).` }))
      .then((erg) => { eintrag.erg = erg; lauf.fertig++; if (nachtrag === lauf) ntFortschritt(); return erg; });
    lauf.eintraege.push(eintrag);
  }
  nachtrag = lauf;
  if (bereits) toast(`${bereits} Bild(er) waren schon nachgetragen und werden übersprungen.`, 4000);
  nachtragZeigen();
}

function ntFortschritt() {
  const n = nachtrag;
  $('#ntZaehler').textContent = `Bild ${n.index + 1} von ${n.eintraege.length}`;
  $('#ntAuswertung').textContent = n.fertig < n.eintraege.length ? `ausgewertet: ${n.fertig} / ${n.eintraege.length}` : 'alle ausgewertet';
}

async function nachtragZeigen() {
  const lauf = nachtrag;
  const eintrag = lauf.eintraege[lauf.index];
  await formularOeffnen(neuerFund(null, null), true);
  ntFortschritt();
  $('#ntDatei').textContent = eintrag.file.name;
  if (ntBildUrl) URL.revokeObjectURL(ntBildUrl);
  ntBildUrl = URL.createObjectURL(eintrag.file);
  const img = $('#ntBild');
  img.hidden = false; img.onerror = () => { img.hidden = true; };
  img.src = ntBildUrl;
  $('#ntKoord').value = '';
  ntStatus(lauf.fertig === 0 && lauf.index === 0
    ? '⏳ Bild wird ausgewertet … (beim ersten Mal wird die Texterkennung geladen, das dauert etwas)'
    : '⏳ Bild wird ausgewertet …');
  $('#formSpeichern').disabled = true;
  requestAnimationFrame(() => ntKarteZeigen(null, null));

  const erg = await eintrag.p;
  if (nachtrag !== lauf || lauf.eintraege[lauf.index] !== eintrag || !bearbeitung) return;
  $('#formSpeichern').disabled = false;

  const zeilen = [];
  if (erg.ortQuelle === 'foto') zeilen.push('📷 Standort aus dem Foto übernommen.');
  else if (erg.ortQuelle === 'screenshot') zeilen.push(`🧭 Koordinaten erkannt: ${erg.roh || alsGradMinSek(erg.lat, erg.lng)} – bitte auf der Karte prüfen.`);
  else zeilen.push('⚠️ Kein Standort gefunden – tippe auf der kleinen Karte auf die Fundstelle oder gib die Koordinaten ein.');
  if (erg.datumQuelle === 'screenshot') zeilen.push('📅 Datum aus dem Screenshot gelesen.');
  else if (erg.datumQuelle === 'foto') zeilen.push('📅 Datum aus dem Foto übernommen.');
  else if (erg.datumQuelle === 'datei') zeilen.push('📅 Datum = Dateidatum, bitte prüfen.');
  if (erg.hinweis) zeilen.push(erg.hinweis);
  ntStatus(zeilen.join('\n'), erg.lat == null);

  if (erg.datum) fSel.datum.value = erg.datum;
  if (erg.lat != null) ntPositionSetzen(erg.lat, erg.lng, { zoom: 15 });
  else ntKarteZeigen(null, null);
  if (erg.istFoto) {
    try {
      const blob = await fotoVerkleinern(eintrag.file);
      if (bearbeitung && nachtrag === lauf && lauf.eintraege[lauf.index] === eintrag) {
        bearbeitung.neuesFoto = blob; fotoVorschau(blob);
      }
    } catch { /* z. B. HEIC in Chrome: Foto dann von Hand waehlen */ }
  }
}

function ntStatus(text, warnung = false) {
  const el = $('#ntStatus');
  el.textContent = text;
  el.classList.toggle('warnung', warnung);
}

function ntKarteZeigen(lat, lng, zoom = 15) {
  if (!ntKarte) {
    ntKarte = L.map('ntKarte', { zoomControl: true, attributionControl: false, maxZoom: 19, minZoom: 6 });
    ntKarte.on('click', (e) => ntPositionSetzen(e.latlng.lat, e.latlng.lng, { zoom: null }));
  }
  if (ntEbene?._fundkarteId !== aktiveEbene) {
    if (ntEbene) ntKarte.removeLayer(ntEbene);
    const def = offline.EBENEN.find((x) => x.id === aktiveEbene) || offline.EBENEN[0];
    ntEbene = L.tileLayer(def.url, { maxZoom: def.maxZoom, maxNativeZoom: def.maxNativeZoom, subdomains: def.subdomains || 'abc' }).addTo(ntKarte);
    ntEbene._fundkarteId = def.id;
  }
  ntKarte.invalidateSize();
  if (lat != null) {
    if (!ntMarker) {
      ntMarker = L.marker([lat, lng], {
        draggable: true, keyboard: false,
        icon: L.divIcon({ className: 'tipp-ziel', html: '<i></i>', iconSize: [36, 36], iconAnchor: [18, 18] }),
      }).on('dragend', () => { const p = ntMarker.getLatLng(); ntPositionSetzen(p.lat, p.lng, { zoom: null }); });
    }
    ntMarker.setLatLng([lat, lng]).addTo(ntKarte);
    if (zoom) ntKarte.setView([lat, lng], zoom); else ntKarte.panTo([lat, lng]);
  } else {
    if (ntMarker) ntKarte.removeLayer(ntMarker);
    // Ohne Position: dort beginnen, wo man zuletzt war (meist dieselbe Gegend)
    const letzter = funde.length ? funde[funde.length - 1] : null;
    if (letzter) ntKarte.setView([letzter.lat, letzter.lng], 12); else ntKarte.setView(map.getCenter(), Math.min(map.getZoom(), 12));
  }
}

function ntPositionSetzen(lat, lng, { zoom = 15 } = {}) {
  if (!bearbeitung) return;
  Object.assign(bearbeitung.fund, { lat, lng, genauigkeit: null, bezirk: null, gemeinde: null, bezirkGkz: null });
  $('#ntKoord').value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  ntKarteZeigen(lat, lng, zoom);
  const st = $('#ntStatus');
  if (st.classList.contains('warnung')) {
    st.textContent = st.textContent.replace(/^⚠️ Kein Standort gefunden[^\n]*/, '📍 Fundstelle gesetzt.');
    st.classList.remove('warnung');
  }
  positionAnzeigen();
}

$('#ntKoord').addEventListener('change', (e) => {
  const k = koordinatenAusText(e.target.value);
  if (!k) { toast('Koordinaten nicht erkannt. Beispiel: 47°44′15″ N 16°23′50″ O oder 47.7375, 16.3972', 5000); return; }
  ntPositionSetzen(k.lat, k.lng);
});

$('#ntUeberspringen').onclick = () => { if (!nachtrag) return; nachtrag.uebersprungen++; nachtragWeiter(); };

function nachtragWeiter() {
  nachtrag.index++;
  if (nachtrag.index >= nachtrag.eintraege.length) { panelSchliessen(); return; } // popstate -> nachtragBeenden
  $('.panel-formular .panel-inhalt').scrollTop = 0;
  nachtragZeigen();
}

function nachtragBeenden() {
  const n = nachtrag;
  nachtrag = null;
  if (ntBildUrl) { URL.revokeObjectURL(ntBildUrl); ntBildUrl = null; }
  $('#formSpeichern').disabled = false;
  aktualisieren();
  const offen = n.eintraege.length - n.index;
  toast(`Nachtragen ${offen > 0 ? 'beendet' : 'fertig'}: ${n.gespeichert} gespeichert, ${n.uebersprungen} übersprungen`
    + `${offen > 0 ? `, ${offen} offen` : ''}${n.bereits ? `, ${n.bereits} schon vorhanden` : ''}.`, 6000);
}

function artenListeFuellen() {
  const arten = [...new Set(funde.map((f) => f.art))].sort((a, b) => a.localeCompare(b, 'de'));
  $('#artenListe').innerHTML = arten.map((a) => `<option value="${esc(a)}">`).join('');
}

// ---------- Panels (mit Zurück-Taste am Handy) ----------
const beimOeffnen = {
  panelListe: () => listeZeichnen(),
  panelFilter: () => filterZeichnen(),
  panelStatistik: () => statistikZeichnen(),
  panelDaten: () => datenZeichnen(),
  panelOffline: () => offlineZeichnen(),
  panelEbenen: () => ebenenZeichnen(),
  panelFalter: () => falterPanelZeichnen(),
};
function allesZu() { $$('.panel').forEach((p) => { p.hidden = true; }); }
function panelOeffnen(id) {
  const war = history.state?.panel;
  allesZu();
  $(`#${id}`).hidden = false;
  if (war) history.replaceState({ panel: id }, ''); else history.pushState({ panel: id }, '');
  beimOeffnen[id]?.();
}
function panelSchliessen() {
  if (history.state?.panel) history.back(); else allesZu();
}
window.addEventListener('popstate', () => {
  allesZu();
  if (history.state?.panel) $(`#${history.state.panel}`).hidden = false;
  // Formular zu (Beenden, ✕, Zurück-Taste) = Nachtragen vorbei
  if (nachtrag && history.state?.panel !== 'panelFormular') nachtragBeenden();
});
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) { panelOeffnen(o.dataset.open); return; }
  if (e.target.closest('.schliessen, .schliessen-btn')) panelSchliessen();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (modus) modusBeenden(); else if (history.state?.panel) panelSchliessen(); }
});

// ---------- Liste ----------
$$('.suche').forEach((inp) => inp.addEventListener('input', () => {
  filter.suche = inp.value;
  $$('.suche').forEach((o) => { if (o !== inp) o.value = inp.value; });
  aktualisieren();
}));
$('#sortierung').onchange = listeZeichnen;

function listeZeichnen() {
  const s = $('#sortierung').value;
  const liste = gefiltert();
  const cmp = {
    'datum-ab': (a, b) => (b.datum || '').localeCompare(a.datum || ''),
    'datum-auf': (a, b) => (a.datum || '').localeCompare(b.datum || ''),
    art: (a, b) => a.art.localeCompare(b.art, 'de'),
    kategorie: (a, b) => typKey(a).localeCompare(typKey(b), 'de') || a.art.localeCompare(b.art, 'de'),
    gemeinde: (a, b) => (a.gemeinde || '~').localeCompare(b.gemeinde || '~', 'de') || (b.datum || '').localeCompare(a.datum || ''),
  }[s];
  liste.sort(cmp);
  $('#listeZahl').textContent = liste.length === funde.length ? `(${funde.length})` : `(${liste.length} von ${funde.length})`;
  const ul = $('#liste');
  if (!liste.length) {
    ul.innerHTML = `<li class="leer">${funde.length ? 'Kein Fund passt zum Filter.' : 'Noch keine Funde.<br>Tippe auf die Karte oder auf „Fund am Standort“.'}</li>`;
    return;
  }
  ul.innerHTML = liste.map((f) => {
    const t = typ(f);
    const ort = f.gemeinde || kurzBezirk(f.bezirk) || '';
    return `<li data-id="${esc(f.id)}">
      <span class="punkt" style="background:${t.farbe}">${t.icon}</span>
      <div class="info">
        <div class="art">${esc(f.art)} ${f.wiss ? `<span class="wiss">${esc(f.wiss)}</span>` : ''}</div>
        <div class="meta">${esc(datumText(f.datum))}${ort ? ` · ${esc(ort)}` : ''}${f.anzahl ? ` · ${esc(f.anzahl)}` : ''}${f.fotoId ? ' · 📷' : ''}</div>
      </div></li>`;
  }).join('');
}
$('#liste').onclick = (e) => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  const m = markerVon.get(li.dataset.id); if (!m) return;
  panelSchliessen();
  setTimeout(() => cluster.zoomToShowLayer(m, () => { map.panTo(m.getLatLng()); m.openPopup(); }), 60);
};

// ---------- Filter ----------
function filterZeichnen() {
  $('#filterTypen').innerHTML = Object.entries(TYPEN).map(([k, t]) => `<button type="button" data-typ="${esc(k)}" aria-pressed="${filter.typen.has(k)}">${t.icon} ${esc(k)}</button>`).join('');
  $('#filterLebensraum').innerHTML = LEBENSRAEUME.map((l) => `<button type="button" data-lr="${esc(l)}" aria-pressed="${filter.lebensraeume.has(l)}">${esc(l)}</button>`).join('');
  const arten = [...new Set(funde.map((f) => f.art))].sort((a, b) => a.localeCompare(b, 'de'));
  $('#filterArt').innerHTML = '<option value="">Alle Arten</option>' + arten.map((a) => `<option ${a === filter.art ? 'selected' : ''}>${esc(a)}</option>`).join('');
  $('#filterVon').value = filter.von; $('#filterBis').value = filter.bis;
}
$('#filterTypen').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const k = b.dataset.typ;
  if (filter.typen.has(k)) filter.typen.delete(k); else filter.typen.add(k);
  b.setAttribute('aria-pressed', String(filter.typen.has(k)));
  aktualisieren();
};
$('#filterLebensraum').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const l = b.dataset.lr;
  if (filter.lebensraeume.has(l)) filter.lebensraeume.delete(l); else filter.lebensraeume.add(l);
  b.setAttribute('aria-pressed', String(filter.lebensraeume.has(l)));
  aktualisieren();
};
$('#filterArt').onchange = (e) => { filter.art = e.target.value; aktualisieren(); };
$('#filterVon').onchange = (e) => { filter.von = e.target.value; aktualisieren(); };
$('#filterBis').onchange = (e) => { filter.bis = e.target.value; aktualisieren(); };
$('#filterZeitSchnell').onclick = (e) => {
  const z = e.target.closest('button')?.dataset.zeit; if (!z) return;
  const d = new Date(); const iso = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  if (z === '30') { filter.bis = iso(d); d.setDate(d.getDate() - 30); filter.von = iso(d); }
  if (z === 'jahr') { filter.von = `${d.getFullYear()}-01-01`; filter.bis = `${d.getFullYear()}-12-31`; }
  if (z === 'vorjahr') { filter.von = `${d.getFullYear() - 1}-01-01`; filter.bis = `${d.getFullYear() - 1}-12-31`; }
  filterZeichnen(); aktualisieren();
};
$('#filterReset').onclick = () => {
  filter.typen = new Set(Object.keys(TYPEN)); filter.art = ''; filter.von = ''; filter.bis = '';
  filter.lebensraeume.clear(); filter.suche = '';
  $$('.suche').forEach((i) => { i.value = ''; });
  filterZeichnen(); aktualisieren();
};

// ---------- Statistik ----------
let statistikJahr = null;
function statistikZeichnen() {
  const liste = gefiltert();
  const el = $('#statistik');
  const arten = new Set(liste.map((f) => f.art.trim().toLowerCase()));
  const pflanzenArten = new Set(liste.filter((f) => f.kategorie === 'Pflanze').map((f) => f.art.trim().toLowerCase()));
  const tierArten = new Set(liste.filter((f) => f.kategorie === 'Tier').map((f) => f.art.trim().toLowerCase()));
  const jahre = [...new Set(liste.map((f) => (f.datum || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  if (!jahre.includes(statistikJahr)) statistikJahr = jahre[0] || String(new Date().getFullYear());
  const proMonat = Array(12).fill(0);
  liste.forEach((f) => { if ((f.datum || '').startsWith(statistikJahr)) proMonat[Number(f.datum.slice(5, 7)) - 1]++; });
  const maxM = Math.max(1, ...proMonat);
  const zaehle = (fn) => { const m = new Map(); liste.forEach((f) => { const k = fn(f); if (k) m.set(k, (m.get(k) || 0) + 1); }); return [...m].sort((a, b) => b[1] - a[1]); };
  const proTyp = zaehle(typKey);
  const topArten = zaehle((f) => f.art).slice(0, 10);
  const proLr = zaehle((f) => f.lebensraum);
  const verteilung = (rows, farbe) => {
    const max = Math.max(1, ...rows.map((x) => x[1]));
    return `<ul class="verteilung">${rows.map(([k, n]) => `<li><span class="name">${esc(k)}</span><span class="bar"><i style="width:${(n / max) * 100}%;background:${typeof farbe === 'function' ? farbe(k) : farbe}"></i></span><span class="zahl">${n}</span></li>`).join('')}</ul>`;
  };
  el.innerHTML = `
    ${filterAnzahl() ? '<p class="hinweis">Gezählt werden nur die gefilterten Funde.</p>' : ''}
    <div class="kacheln">
      <div class="kachel"><b>${liste.length}</b><span>Funde</span></div>
      <div class="kachel"><b>${arten.size}</b><span>Arten</span></div>
      <div class="kachel"><b>${pflanzenArten.size}</b><span>Pflanzenarten</span></div>
      <div class="kachel"><b>${tierArten.size}</b><span>Tierarten</span></div>
    </div>
    <h3>Funde pro Monat
      <select id="statJahr" style="width:auto;min-height:36px;margin-left:.5rem;padding:.2rem .5rem">${(jahre.length ? jahre : [statistikJahr]).map((j) => `<option ${j === statistikJahr ? 'selected' : ''}>${j}</option>`).join('')}</select>
    </h3>
    <div class="balken">${proMonat.map((n) => `<div><em>${n || ''}</em><i style="height:${(n / maxM) * 100}%"></i></div>`).join('')}</div>
    <div class="balken-achse">${MONATE.map((m) => `<span>${m}</span>`).join('')}</div>
    ${proTyp.length ? `<h3>Nach Kategorie</h3>${verteilung(proTyp, (k) => TYPEN[k].farbe)}` : ''}
    ${topArten.length ? `<h3>Häufigste Arten</h3>${verteilung(topArten, '#6b8f47')}` : ''}
    ${proLr.length ? `<h3>Nach Lebensraum</h3>${verteilung(proLr, '#6d5136')}` : ''}`;
  $('#statJahr').onchange = (e) => { statistikJahr = e.target.value; statistikZeichnen(); };
}

// ---------- Export / Import ----------
const CSV_SPALTEN = [
  ['ID', (f) => f.id], ['Datum', (f) => (f.datum || '').slice(0, 10)], ['Uhrzeit', (f) => (f.datum || '').slice(11, 16)],
  ['Kategorie', (f) => f.kategorie], ['Gruppe', (f) => (f.kategorie === 'Tier' ? f.gruppe : '')],
  ['Artname', (f) => f.art], ['Wissenschaftlicher Name', (f) => f.wiss], ['Anzahl', (f) => f.anzahl],
  ['Lebensraum', (f) => f.lebensraum], ['Gemeinde', (f) => f.gemeinde], ['Bezirk', (f) => f.bezirk],
  ['Breite', (f) => f.lat.toFixed(6)], ['Länge', (f) => f.lng.toFixed(6)],
  ['Genauigkeit (m)', (f) => (f.genauigkeit ? Math.round(f.genauigkeit) : '')],
  ['Notiz', (f) => f.notiz], ['Foto', (f) => (f.fotoId ? 'ja' : 'nein')],
];
const stempel = () => new Date().toISOString().slice(0, 10);

$('#exportCsv').onclick = () => {
  // Semikolon + BOM: so öffnet Excel mit deutschen Einstellungen die Datei direkt richtig
  const zelle = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const zeilen = [CSV_SPALTEN.map((s) => s[0]).join(';'), ...gefiltert().map((f) => CSV_SPALTEN.map(([, fn]) => zelle(fn(f))).join(';'))];
  datei(new Blob(['﻿' + zeilen.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `funde-${stempel()}.csv`);
};

const EIGENSCHAFTEN = ['id', 'kategorie', 'gruppe', 'art', 'wiss', 'datum', 'anzahl', 'lebensraum', 'notiz', 'gemeinde', 'bezirk', 'genauigkeit', 'erstellt', 'geaendert', 'importKey'];
function alsFeature(f) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(f.lng.toFixed(7)), Number(f.lat.toFixed(7))] },
    properties: Object.fromEntries(EIGENSCHAFTEN.map((k) => [k, f[k] ?? null])),
  };
}
const blobZuDataUrl = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

$('#exportGeojson').onclick = () => {
  const fc = { type: 'FeatureCollection', features: gefiltert().map(alsFeature) };
  datei(new Blob([JSON.stringify(fc, null, 1)], { type: 'application/geo+json' }), `funde-${stempel()}.geojson`);
};
$('#exportSicherung').onclick = async () => {
  toast('Sicherung wird erstellt …', 30000);
  const features = [];
  for (const f of funde) {
    const ft = alsFeature(f);
    if (f.fotoId) { const b = await db.fotoLaden(f.fotoId); if (b) ft.properties.foto = await blobZuDataUrl(b); }
    features.push(ft);
  }
  const fc = { type: 'FeatureCollection', fundkarte: { version: VERSION, gesichert: new Date().toISOString() }, features };
  datei(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), `fundkarte-sicherung-${stempel()}.geojson`);
  toast(`${features.length} Funde gesichert`);
};

$('#importDatei').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  let fc;
  try { fc = JSON.parse(await file.text()); } catch { toast('Die Datei ist kein gültiges GeoJSON.', 4000); return; }
  const feats = fc.type === 'FeatureCollection' ? fc.features : (fc.type === 'Feature' ? [fc] : []);
  let neu = 0; let ersetzt = 0; let uebersprungen = 0;
  toast('Import läuft …', 60000);
  for (const ft of feats) {
    if (ft?.geometry?.type !== 'Point') { uebersprungen++; continue; }
    const [lng, lat] = ft.geometry.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { uebersprungen++; continue; }
    const p = ft.properties || {};
    const kat = ['Pflanze', 'Tier'].includes(p.kategorie) ? p.kategorie : 'Tier';
    const f = {
      id: String(p.id || db.neueId()),
      kategorie: kat,
      gruppe: kat === 'Tier' ? (GRUPPEN.includes(p.gruppe) ? p.gruppe : 'Sonstiges') : null,
      art: String(p.art || p.artname || p.name || p.species || 'Unbenannte Art'),
      wiss: String(p.wiss || p.scientificName || p.scientific_name || ''),
      datum: String(p.datum || p.date || p.eventDate || lokalJetzt()).slice(0, 16),
      anzahl: String(p.anzahl ?? p.count ?? ''), lebensraum: String(p.lebensraum || ''),
      notiz: String(p.notiz || p.note || p.description || ''),
      lat, lng, genauigkeit: Number(p.genauigkeit) || null,
      gemeinde: p.gemeinde || null, bezirk: p.bezirk || null,
      erstellt: p.erstellt || new Date().toISOString(), geaendert: p.geaendert || new Date().toISOString(),
      importKey: p.importKey || null,
      fotoId: null,
    };
    const alt = funde.find((x) => x.id === f.id);
    if (alt && (alt.geaendert || '') >= f.geaendert) { uebersprungen++; continue; }
    if (alt?.fotoId) f.fotoId = alt.fotoId;
    if (typeof p.foto === 'string' && p.foto.startsWith('data:image/')) {
      const blob = await (await fetch(p.foto)).blob();
      f.fotoId = f.fotoId || db.neueId();
      await db.fotoSpeichern(f.fotoId, blob);
    }
    if (!f.bezirk) Object.assign(f, await ortBestimmen(lat, lng));
    await db.fundSpeichern(f);
    if (alt) { funde = funde.map((x) => (x.id === f.id ? f : x)); ersetzt++; } else { funde.push(f); neu++; }
  }
  aktualisieren(); datenZeichnen();
  toast(`Import: ${neu} neu, ${ersetzt} aktualisiert, ${uebersprungen} übersprungen`, 5000);
  db.dauerhaftAnfordern();
};

async function datenZeichnen() {
  $('#exportZahl').textContent = gefiltert().length;
  let text = `${funde.length} Funde, davon ${funde.filter((f) => f.fotoId).length} mit Foto.`;
  try {
    const est = await navigator.storage?.estimate?.();
    const fest = await navigator.storage?.persisted?.();
    if (est) text += ` Belegt: ${(est.usage / 1048576).toFixed(1)} MB (inkl. Offline-Karten).`;
    text += fest ? ' Speicher ist dauerhaft geschützt.' : ' Speicher ist nicht dauerhaft geschützt – regelmäßig sichern!';
  } catch { /* egal */ }
  $('#speicherInfo').textContent = text;
}

// ---------- Bezirke & Ebenen ----------
function bezirkOptionen() {
  const nachLand = new Map();
  bezirke.features.forEach((f) => { const l = f.properties.land; if (!nachLand.has(l)) nachLand.set(l, []); nachLand.get(l).push(f); });
  return [...nachLand].map(([land, fs]) => `<optgroup label="${esc(land)}">${fs.map((f) => `<option value="${esc(f.properties.gkz)}">${esc(kurzBezirk(f.properties.name))}</option>`).join('')}</optgroup>`).join('');
}

const bboxImBlick = (bb, g) => bb[2] >= g.getWest() && bb[0] <= g.getEast() && bb[3] >= g.getSouth() && bb[1] <= g.getNorth();

// Gemeindegrenzen nur fuer die Bezirke im Kartenausschnitt laden – ganz Oesterreich
// sind ~12 MB, so sind es meist ein paar hundert KB.
let gemeindenOfflineGemeldet = false;
async function gemeindenAktualisieren() {
  if (!bezirke) return;
  const an = () => $('#chkGemeinden').checked && map.getZoom() >= GEMEINDEN_AB_ZOOM;
  const imBlick = (gkz) => bboxImBlick(bezirke.features.find((f) => f.properties.gkz === gkz).properties.bbox, map.getBounds().pad(0.15));
  const sichtbar = an() ? bezirke.features.map((f) => f.properties.gkz).filter(imBlick) : [];
  for (const [gkz, l] of gemeindenJe) {
    if (!sichtbar.includes(gkz)) {
      gemeindenLayer.removeLayer(l);
      if (gemeindenJe.size > 30) gemeindenJe.delete(gkz); // Speicher am Handy begrenzen
    }
  }
  for (const gkz of sichtbar) {
    let l = gemeindenJe.get(gkz);
    if (!l) {
      try {
        const g = await gemeindenLaden(gkz);
        l = gemeindenJe.get(gkz) || L.geoJSON(g, { renderer: grenzRenderer, interactive: false, style: () => grenzStil('gemeinde') });
        gemeindenJe.set(gkz, l);
      } catch {
        if (!gemeindenOfflineGemeldet) toast('Gemeindegrenzen für dieses Gebiet sind offline nicht gespeichert.');
        gemeindenOfflineGemeldet = true;
        continue;
      }
    }
    // Waehrend des Ladens kann sich der Ausschnitt geaendert haben
    if (an() && imBlick(gkz)) gemeindenLayer.addLayer(l);
  }
}

function bezirkImBlick() {
  if (!bezirke) return null;
  const c = map.getCenter();
  return bezirkFinden(bezirke, c.lat, c.lng);
}

function kopfAktualisieren() {
  const b = map.getZoom() >= 9 ? bezirkImBlick() : null;
  $('#kopfBezirk').textContent = b ? kurzBezirk(b.properties.name) : 'Österreich';
}

let ansichtTimer = null;
map.on('moveend', () => {
  kopfAktualisieren();
  gemeindenAktualisieren();
  clearTimeout(ansichtTimer);
  ansichtTimer = setTimeout(() => {
    const c = map.getCenter();
    db.einstellungSchreiben('ansicht', { lat: c.lat, lng: c.lng, z: map.getZoom() });
  }, 800);
});

function ebenenZeichnen() {
  $('#ebenenListe').innerHTML = offline.EBENEN.map((e) => `
    <label><input type="radio" name="ebene" value="${e.id}" ${e.id === aktiveEbene ? 'checked' : ''}>
    <span>${esc(e.name)}</span><small>${esc(e.quelle)}${e.offline ? ' ⤓' : ''}</small></label>`).join('');
  $('#bezirkWahl').value = '';
}
$('#ebenenListe').onchange = (e) => ebeneSetzen(e.target.value);
$('#bezirkWahl').onchange = (e) => {
  const b = bezirke.features.find((f) => f.properties.gkz === e.target.value);
  if (!b) return;
  const [w, s, o, n] = b.properties.bbox;
  panelSchliessen();
  map.fitBounds([[s, w], [n, o]], { padding: [20, 20] });
};
$('#chkGemeinden').onchange = (e) => {
  db.einstellungSchreiben('gemeinden', e.target.checked);
  if (e.target.checked && map.getZoom() < GEMEINDEN_AB_ZOOM) toast('Gemeindegrenzen erscheinen, sobald du näher hineinzoomst.');
  gemeindenAktualisieren();
};
$('#chkBezirke').onchange = (e) => {
  db.einstellungSchreiben('bezirke', e.target.checked);
  if (e.target.checked) bezirkeLayer.addTo(map); else map.removeLayer(bezirkeLayer);
};

// ---------- Offline-Karten ----------
let downloadAbbruch = null;
function offlineZeichnen() {
  if (!$('#offlineBezirk').options.length) $('#offlineBezirk').innerHTML = bezirkOptionen();
  if (!downloadAbbruch) $('#offlineBezirk').value = bezirkImBlick()?.properties.gkz || $('#offlineBezirk').value;
  if (!$('#offlineEbenen').children.length) {
    $('#offlineEbenen').innerHTML = offline.EBENEN.filter((e) => e.offline).map((e) => `
      <label class="schalter"><input type="checkbox" value="${e.id}" ${e.id === 'bmap' ? 'checked' : ''}> ${esc(e.name)} <small class="hinweis">(${esc(e.quelle)})</small></label>`).join('');
  }
  offlineSchaetzen();
  offline.bestand().then(({ anzahl }) => { $('#offlineBestand').textContent = anzahl ? `${anzahl.toLocaleString('de-AT')} Kacheln gespeichert.` : 'Noch keine Karten offline gespeichert.'; });
}
const MAX_KACHELN = 60000;
let offlinePlan = null;
function offlineSchaetzen() {
  const b = bezirke.features.find((f) => f.properties.gkz === $('#offlineBezirk').value);
  const ids = $$('#offlineEbenen input:checked').map((i) => i.value);
  if (!b || !ids.length) { offlinePlan = null; $('#offlineSchaetzung').textContent = 'Bitte mindestens eine Karte wählen.'; $('#offlineStart').disabled = true; return; }
  offlinePlan = offline.planen(b, ids, Number($('#offlineZoom').value));
  const n = offlinePlan.urls.length;
  const zuGross = n > MAX_KACHELN;
  $('#offlineSchaetzung').innerHTML = `${esc(kurzBezirk(b.properties.name))}: <b>${n.toLocaleString('de-AT')}</b> Kacheln, ca. <b>${Math.max(1, Math.round(offlinePlan.mb))} MB</b>.`
    + (zuGross ? ' <br>Das ist zu viel auf einmal – bitte eine geringere Detailstufe oder weniger Karten wählen.' : '');
  $('#offlineStart').disabled = zuGross || !!downloadAbbruch;
}
$('#offlineBezirk').onchange = offlineSchaetzen;
$('#offlineZoom').onchange = offlineSchaetzen;
$('#offlineEbenen').onchange = offlineSchaetzen;
$('#offlineStart').onclick = async () => {
  if (!offlinePlan || !('caches' in window)) { toast('Dieser Browser unterstützt keine Offline-Karten.'); return; }
  db.dauerhaftAnfordern();
  downloadAbbruch = new AbortController();
  $('#offlineStart').disabled = true; $('#offlineStopp').hidden = false; $('#offlineFortschritt').hidden = false;
  const gkz = $('#offlineBezirk').value;
  gemeindenLaden(gkz).catch(() => {}); // Gemeindegrenzen gleich mit in den Cache
  const balken = $('#offlineFortschritt div');
  const { fertig, fehler } = await offline.herunterladen(offlinePlan.urls, {
    signal: downloadAbbruch.signal,
    onFortschritt: (n, gesamt, f) => {
      balken.style.width = `${(n / gesamt) * 100}%`;
      $('#offlineStatus').textContent = `${n.toLocaleString('de-AT')} von ${gesamt.toLocaleString('de-AT')} Kacheln${f ? ` · ${f} Fehler` : ''}`;
    },
  });
  const abgebrochen = downloadAbbruch.signal.aborted;
  downloadAbbruch = null;
  $('#offlineStopp').hidden = true;
  $('#offlineStatus').textContent = abgebrochen
    ? `Abgebrochen nach ${fertig.toLocaleString('de-AT')} Kacheln. Nochmal starten setzt fort.`
    : `Fertig. ${fehler ? `${fehler} Kacheln fehlgeschlagen – nochmal starten lädt nur die fehlenden.` : 'Der Bezirk ist jetzt offline verfügbar.'}`;
  offlineZeichnen();
};
$('#offlineStopp').onclick = () => downloadAbbruch?.abort();
$('#offlineLoeschen').onclick = async () => {
  if (!confirm('Alle offline gespeicherten Kartenkacheln löschen? Deine Funde bleiben erhalten.')) return;
  await offline.allesLoeschen();
  offlineZeichnen();
  toast('Offline-Karten gelöscht');
};

// ---------- Online/Offline-Anzeige ----------
function netzAnzeigen() { $('#offlineHinweis').hidden = navigator.onLine; }
window.addEventListener('online', netzAnzeigen);
window.addEventListener('offline', netzAnzeigen);

// ---------- Start ----------
async function start() {
  netzAnzeigen();
  letzteKarte = (await db.einstellungLesen('karte')) || 'osm';
  ebeneSetzen((await db.einstellungLesen('ebene')) || 'osm');
  funde = (await db.alleFunde()) || [];
  const letzter = [...funde].sort((a, b) => (b.erstellt || '').localeCompare(a.erstellt || ''))[0];
  if (letzter) letzteKategorie = { kategorie: letzter.kategorie, gruppe: letzter.gruppe };
  aktualisieren();

  bezirke = await bezirkeLaden();
  bezirkeLayer.addData(bezirke);
  gemeindenLayer.addTo(map);
  const bezirkeAn = (await db.einstellungLesen('bezirke')) ?? true;
  $('#chkBezirke').checked = bezirkeAn;
  if (bezirkeAn) bezirkeLayer.addTo(map);
  $('#chkGemeinden').checked = !!(await db.einstellungLesen('gemeinden'));
  $('#bezirkWahl').innerHTML = '<option value="">– Bezirk wählen –</option>' + bezirkOptionen();
  const ansicht = await db.einstellungLesen('ansicht');
  if (ansicht) map.setView([ansicht.lat, ansicht.lng], ansicht.z);
  else map.fitBounds(bezirkeLayer.getBounds(), { padding: [10, 10] });
  kopfAktualisieren();
  gemeindenAktualisieren();
  await falterStarten({ map, db, toast, esc, cluster, bezirke: () => bezirke, panelOeffnen });
}
start().catch((e) => { console.error(e); toast(`Fehler beim Start: ${e.message}`, 8000); });

// ---------- Updates ----------
// iPhone-Web-Apps werden beim Antippen oft nur aus dem Hintergrund geholt statt neu
// geladen – dann fragt niemand nach einer neuen Version. Deshalb selbst nachfragen,
// wenn die App wieder sichtbar wird, und neu laden, sobald die neue Version bereitliegt.
// Wer gerade etwas eintraegt, bekommt stattdessen einen Hinweis mit Knopf.
$$('.app-version').forEach((el) => { el.textContent = VERSION; });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hatteVersion = !!navigator.serviceWorker.controller; // false = allererster Start
  let zuletztGeprueft = Date.now();
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const pruefen = () => {
      if (Date.now() - zuletztGeprueft < 30000) return;
      zuletztGeprueft = Date.now();
      reg.update().catch(() => { /* offline: beim naechsten Mal */ });
    };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pruefen(); });
    window.addEventListener('online', pruefen);
  }).catch((e) => console.warn('Service Worker:', e));

  let neuGeladen = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hatteVersion || neuGeladen) return;
    neuGeladen = true;
    if (!history.state?.panel && !modus) location.reload();
    else $('#updateHinweis').hidden = false;
  });
}
$('#updateLaden').onclick = () => location.reload();
