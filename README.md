# Fundkarte

Web-App zum Erfassen von Pflanzen- und Tierfunden in Österreich, gedacht fürs Handy im Gelände.
Reine statische Seite (HTML/CSS/JS, kein Build-Schritt), installierbar als App (PWA), funktioniert offline.

Live: https://danielmulti777.github.io/fundkarte/

- Daten bleiben im Browser des Geräts (IndexedDB). Austausch/Sicherung über GeoJSON-Export.
- Karten: OpenStreetMap, basemap.at (Karte, Orthofoto, Gelände), OpenTopoMap.
- Offline: App + Funde immer; Kartenkacheln von basemap.at je Bezirk vorab ladbar.
- Alte Funde nachtragen: viele Bilder auf einmal; Standort/Datum aus Foto-EXIF (exifr) oder per
  Texterkennung aus Kompass-Screenshots (Tesseract.js, läuft am Gerät, Dateien unter `vendor/`).

## Lokal starten

    python scripts/server.py 4330

Dann http://127.0.0.1:4330 öffnen. Der Server liefert nur die App-Dateien aus (keine
versteckten Dateien, keine Ordnerlisten). GPS und Offline-Modus brauchen am Handy eine https-Adresse.

## Tagfalter-Datenbank (GBIF)

    python scripts/schmetterlinge_holen.py            # Burgenland über die GBIF-Suche (ohne Konto)
    python scripts/schmetterlinge_holen.py --download # ganz Österreich, offizieller Download

Schreibt `data/falter/` (Übersichtsraster, Einzelsichtungen je Bezirk, Artenliste mit deutschen
Namen). Doppelte Meldungen (gleiche Art, Tag, ~100 m) werden zusammengefasst, Synonyme
(gleiche Familie + Epitheton) vereinigt. Monatlich aktualisiert über `.github/workflows/falter.yml`;
dafür die Repository-Secrets `GBIF_USER` und `GBIF_PWD` setzen.

## Tests

    node scripts/erkennung_test.mjs

Prüft das Auslesen von Koordinaten und Datum aus erkanntem Text (`js/erkennung.js`).

## Grenzen neu erzeugen

    python scripts/grenzen_holen.py

Holt Bezirks- und Gemeindegrenzen aus OpenStreetMap (Overpass) nach `data/`.

## Nach Änderungen

`VERSION` in `sw.js` erhöhen, sonst behalten installierte Apps die alte Fassung.
Veröffentlichen = `git push` auf `main` (GitHub Pages baut automatisch).
