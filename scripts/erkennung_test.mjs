// Tests fuer js/erkennung.js – Aufruf: node scripts/erkennung_test.mjs
import assert from 'node:assert/strict';
import { koordinatenAusText, datumAusText, alsGradMinSek } from '../js/erkennung.js';

let ok = 0;
function test(name, fn) {
  try { fn(); ok++; } catch (e) { console.error(`FEHLER ${name}\n  ${e.message}`); process.exitCode = 1; }
}
const nahe = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
function koord(text, lat, lng) {
  const k = koordinatenAusText(text);
  assert.ok(k, `nichts erkannt in: ${JSON.stringify(text)}`);
  assert.ok(nahe(k.lat, lat) && nahe(k.lng, lng), `erwartet ${lat},${lng} – bekommen ${k.lat},${k.lng}`);
}
const MB = [47 + 44 / 60 + 15 / 3600, 16 + 23 / 60 + 50 / 3600]; // Mattersburg

// --- iPhone-Kompass, verschiedene OCR-Ergebnisse ---
test('Kompass sauber', () => koord('47°44′15″ N  16°23′50″ O', ...MB));
test('Kompass mit Leerzeichen', () => koord('47° 44′ 15″ N   16° 23′ 50″ O', ...MB));
test('Kompass ASCII-Striche', () => koord(`47°44'15" N 16°23'50" O`, ...MB));
test('Kompass typogr. Anfuehrung', () => koord('47°44’15” N 16°23’50” O', ...MB));
test('Kompass doppeltes Hochkomma', () => koord("47°44'15'' N 16°23'50'' O", ...MB));
test('Kompass ohne Leerzeichen vor N', () => koord(`47°44'15"N 16°23'50"O`, ...MB));
test('Kompass 0 statt O', () => koord(`47°44'15" N 16°23'50" 0`, ...MB));
test('Kompass º statt °', () => koord(`47º44'15" N 16º23'50" O`, ...MB));
test('Kompass mehrzeilig mit Ort und Hoehe', () => koord(
  `12:41\n\n N\n 274°W\n\n47°44'15" N 16°23'50" O\nMattersburg, Burgenland\n234 m Höhe`, ...MB));
test('Kompass Englisch E', () => koord(`47°44'15" N 16°23'50" E`, ...MB));
test('Sekunden mit Komma', () => koord(`47°44'15,6" N 16°23'50,2" O`, 47 + 44 / 60 + 15.6 / 3600, 16 + 23 / 60 + 50.2 / 3600));
test('Grad + Dezimalminuten', () => koord(`N 47°44.250' ... 47°44.250' N 16°23.833' E`, 47 + 44.25 / 60, 16 + 23.833 / 60));
test('Dezimalgrad mit Richtung', () => koord('47.73750° N, 16.39722° E', 47.7375, 16.39722));
test('Dezimalpaar Google Maps', () => koord('47.737500, 16.397220', 47.7375, 16.39722));
test('Dezimalpaar ohne Leerzeichen', () => koord('47.7375,16.39722', 47.7375, 16.39722));
test('Sued/West', () => koord(`33°51'35" S 151°12'40" E`, -(33 + 51 / 60 + 35 / 3600), 151 + 12 / 60 + 40 / 3600));
test('Laenge vor Breite', () => koord(`16°23'50" O 47°44'15" N`, ...MB));

// --- verschluckte oder verwechselte Zeichen (echte OCR-Fehler) ---
test('Minutenstrich fehlt', () => koord(`47°4415" N 16°23'50" O`, ...MB));
test('Minutenstrich fehlt bei beiden', () => koord(`47°4415" N 16°2350" O`, ...MB));
test('Leerzeichen statt Minutenstrich', () => koord(`47°44 15" N 16°23 50" O`, ...MB));
test('o statt Gradzeichen', () => koord(`47o44'15" N 16o23'50" O`, ...MB));
test('Stern statt Gradzeichen', () => koord(`47*44'15" N 16*23'50" O`, ...MB));
test('Gradzeichen fehlt', () => koord(`4744'15" N 1623'50" O`, ...MB));
test('Zwei Zeilen mit Datum (Live-Fall)', () => koord(`47°4415" N 16°23'50" O\n14. Juni 2025 08:05`, ...MB));

// --- echter iPhone-Kompass-Screenshot (Bruck an der Mur), Original-Ausgabe der Texterkennung ---
const BRUCK = [47 + 23 / 60 + 52 / 3600, 15 + 21 / 60 + 11 / 3600];
const BRUCK_OCR = '10:40 ® . | 5G am)\n30 | 60\n0 Ni 90\nS 2\n330 S N © Z 120\n300 El HN 150\nTy, AN\n270 pW 180\n240 210\n44° NO\n47°23\'52" N 15°21"11" O\nBruck an der Mur, Steiermark\n1510 m Hohe\n';
test('echter Screenshot Bruck (Minutenstrich als ")', () => koord(BRUCK_OCR, ...BRUCK));
test('echter Screenshot: kein Datum erfunden', () => assert.equal(datumAusText(BRUCK_OCR, new Date(2026, 10, 22)), null));
test('Minutenstrich als " bei beiden', () => koord(`47°23"52" N 15°21"11" O`, ...BRUCK));

test('kein Treffer bei Hoehe/Uhrzeit', () => assert.equal(koordinatenAusText('234 m Höhe 12:41 Mattersburg'), null));
test('kein Treffer bei Kompasskurs', () => assert.equal(koordinatenAusText('274° W'), null));
test('ungueltige Minuten', () => assert.equal(koordinatenAusText(`47°74'15" N 16°23'50" O`), null));
test('Wort danach nicht als Richtung', () => assert.equal(koordinatenAusText('47.7375 Nord-West'), null));

// --- Datum ---
const jetzt = new Date(2026, 10, 22);
const datum = (t, erw) => assert.equal(datumAusText(t, jetzt), erw);
test('Datum numerisch', () => datum('Fund am 14.06.2025', '2025-06-14T12:00'));
test('Datum numerisch mit Zeit', () => datum('14.06.2025 14:23', '2025-06-14T14:23'));
test('Datum kurzes Jahr', () => datum('3.5.24', '2024-05-03T12:00'));
test('Datum Monatsname', () => datum('Samstag\n14. Juni 2025 um 08:05', '2025-06-14T08:05'));
test('Datum Jänner', () => datum('3. Jänner 2024', '2024-01-03T12:00'));
test('Datum Maerz ohne Umlaut (OCR)', () => datum('21. Marz 2025', '2025-03-21T12:00'));
test('Datum Abkuerzung', () => datum('7 Okt. 2023', '2023-10-07T12:00'));
test('Datum ISO', () => datum('2025-06-14 09:30', '2025-06-14T09:30'));
test('kein Datum aus Koordinaten', () => datum(`47°44'15" N 16°23'50" O 47.7375, 16.3972`, null));
test('kein Datum in der Zukunft', () => datum('14.06.2031', null));
test('ungueltiger Tag', () => datum('31.02.2025', null));
test('Statusleisten-Uhrzeit allein ist kein Datum', () => datum('12:41', null));

// --- Anzeige ---
test('Grad/Min/Sek-Anzeige', () => assert.equal(alsGradMinSek(...MB), '47°44′15″ N 16°23′50″ O'));
test('Anzeige Rundung auf 60', () => assert.equal(alsGradMinSek(47.99999, 16.5), '48°00′00″ N 16°30′00″ O'));

console.log(`${ok} Tests bestanden${process.exitCode ? ', es gab Fehler' : ''}`);
