# Fundkarte

Web-App zum Erfassen von Pflanzen- und Tierfunden in Österreich, gedacht fürs Handy im Gelände.
Reine statische Seite (HTML/CSS/JS, kein Build-Schritt), installierbar als App (PWA), funktioniert offline.

- Daten bleiben im Browser des Geräts (IndexedDB). Austausch/Sicherung über GeoJSON-Export.
- Karten: OpenStreetMap, basemap.at (Karte, Orthofoto, Gelände), OpenTopoMap.
- Offline: App + Funde immer; Kartenkacheln von basemap.at je Bezirk vorab ladbar.

## Lokal starten

    python -m http.server 4330 --directory .

Dann http://localhost:4330 öffnen. GPS und Offline-Modus brauchen am Handy eine https-Adresse.

## Grenzen neu erzeugen

    python scripts/grenzen_holen.py

Holt Bezirks- und Gemeindegrenzen aus OpenStreetMap (Overpass) nach `data/`.

## Nach Änderungen

`VERSION` in `sw.js` erhöhen, sonst behalten installierte Apps die alte Fassung.
