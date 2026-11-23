"""Tagfalter-Nachweise aus GBIF holen und fuer die App aufbereiten.

Ergebnis unter data/falter/:
  meta.json          Stand, Quellenliste (Datensatz + Lizenz), abgedeckte Gebiete, Zitat
  arten.json         Arten (wiss. + deutscher Name, Anzahl)
  raster.json        Uebersicht: ~5x5-km-Kaestchen, je Art Anzahl Sichtungen in 6 Zeitbloecken
  b/<gkz>.json       Einzelsichtungen je Bezirk (spaltenweise, kompakt)

Doppelte Meldungen (gleiche Art, gleicher Tag, ~100 m) werden zu einer Sichtung
zusammengefasst, die Quellen bleiben erhalten. Beobachternamen werden bewusst
nicht uebernommen – der Link zum GBIF-Original fuehrt zu allen Details.

Aufruf:
  python scripts/schmetterlinge_holen.py                 # Burgenland (Standard)
  python scripts/schmetterlinge_holen.py AUT.1_1 AUT.3_1 # mehrere Bundeslaender (GADM-IDs)
  python scripts/schmetterlinge_holen.py --download      # ganz Oesterreich, offizieller Download
                                                         # (GBIF_USER, GBIF_PWD als Umgebungsvariablen)

Abruf ueber die normale GBIF-Suche (ohne Konto). Fuer ganz Oesterreich ist das zu
viel (~6 KB je Datensatz); dafuer kommt der offizielle GBIF-Download mit Konto dazu.
Jede abgerufene Seite wird unter scripts/.cache/gbif/ gespeichert – ein
Wiederholungslauf kostet keine Anfragen.
"""

import collections
import datetime as dt
import gzip
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grenzen_holen import point_in_ring  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "falter"
CACHE = Path(__file__).resolve().parent / ".cache" / "gbif"
API = "https://api.gbif.org/v1/"
UA = {"User-Agent": "fundkarte/1.0 (private Naturbeobachtung; Tagfalter-Aufbereitung)"}

# Tagfalter = Papilionoidea inkl. Dickkopffalter: GBIF-Schluessel der Familien
FAMILIEN = {
    "Papilionidae": 9417, "Pieridae": 5481, "Nymphalidae": 7017,
    "Lycaenidae": 5473, "Riodinidae": 1933999, "Hesperiidae": 6953,
}
GEBIETE = {
    "AUT.1_1": "Burgenland", "AUT.2_1": "Kärnten", "AUT.3_1": "Niederösterreich",
    "AUT.4_1": "Oberösterreich", "AUT.5_1": "Salzburg", "AUT.6_1": "Steiermark",
    "AUT.7_1": "Tirol", "AUT.8_1": "Vorarlberg", "AUT.9_1": "Wien",
}
# Zeitbloecke der Uebersicht (Start-Jahr, inklusiv); muss zu js/falter.js passen
BLOECKE = [0, 1950, 1980, 2000, 2010, 2020]
# Raster: ~5 km. Ursprung suedwestlich von Oesterreich.
RASTER = {"lat0": 46.30, "lng0": 9.40, "dlat": 0.045, "dlng": 0.0667}
MAX_UNGENAU = 5000  # Meter; ungenauer als ein Kaestchen -> fuer die Karte unbrauchbar
SEITE = 300


def get(path, **params):
    url = API + path + ("?" + urllib.parse.urlencode(params, doseq=True) if params else "")
    for versuch in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - GBIF hat gelegentlich Aussetzer
            print(f"   {e} – neuer Versuch", flush=True)
            time.sleep(5 + versuch * 10)
    raise RuntimeError(f"GBIF nicht erreichbar: {url}")


def basisfilter(gebiet):
    return dict(
        gadmGid=gebiet, taxonKey=list(FAMILIEN.values()), hasCoordinate="true",
        hasGeospatialIssue="false", occurrenceStatus="PRESENT",
    )


def abschnitte(gebiet, von=1700, bis=None):
    """Nach Jahren teilen: GBIF blaettert hoechstens bis 100.000 und wird ab ~10.000 sehr langsam."""
    bis = bis or dt.date.today().year
    n = get("occurrence/search", limit=0, year=f"{von},{bis}", **basisfilter(gebiet))["count"]
    if n <= 9000 or von == bis:  # tiefes Blaettern ist bei GBIF sehr langsam
        return [(von, bis, n)]
    mitte = (von + bis) // 2
    return abschnitte(gebiet, von, mitte) + abschnitte(gebiet, mitte + 1, bis)


def seiten(gebiet):
    """Alle Datensaetze eines Gebiets, seitenweise (mit Cache)."""
    ziel = CACHE / gebiet
    ziel.mkdir(parents=True, exist_ok=True)
    for von, bis, n in abschnitte(gebiet):
        print(f"  {GEBIETE.get(gebiet, gebiet)} {von}–{bis}: {n} Datensaetze", flush=True)
        for off in range(0, n, SEITE):
            cf = ziel / f"{von}-{bis}-{off:06d}.json.gz"
            if cf.exists():
                ergebnisse = json.loads(gzip.decompress(cf.read_bytes()))
            else:
                r = get("occurrence/search", limit=SEITE, offset=off, year=f"{von},{bis}",
                        **basisfilter(gebiet))
                # Nur die Felder behalten, die wir brauchen – der Cache waere sonst riesig
                ergebnisse = [{k: x.get(k) for k in (
                    "key", "speciesKey", "species", "family", "year", "month", "day",
                    "decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters",
                    "datasetKey", "datasetName", "license", "basisOfRecord")} for x in r["results"]]
                cf.write_bytes(gzip.compress(json.dumps(ergebnisse).encode()))
                time.sleep(0.3)
                if (off // SEITE) % 10 == 0:
                    print(f"    {off + len(ergebnisse)} / {n}", flush=True)
            yield from ergebnisse


def download(gebiet_land="AT"):
    """Offizieller GBIF-Download (braucht Konto): eine gepackte Tabelle statt
    tausender Suchseiten, dazu eine DOI zum Zitieren. Zugangsdaten nur aus
    Umgebungsvariablen (GBIF_USER, GBIF_PWD, GBIF_EMAIL) – lokal oder als
    GitHub-Secret gesetzt, nie im Code."""
    import base64
    import csv
    import io
    import os
    import zipfile

    user, pwd = os.environ.get("GBIF_USER"), os.environ.get("GBIF_PWD")
    if not user or not pwd:
        sys.exit("GBIF_USER und GBIF_PWD fehlen (Umgebungsvariablen).")
    auth = {"Authorization": "Basic " + base64.b64encode(f"{user}:{pwd}".encode()).decode()}
    anfrage = {
        "creator": user,
        "sendNotification": False,
        "format": "SIMPLE_CSV",
        "predicate": {"type": "and", "predicates": [
            {"type": "equals", "key": "COUNTRY", "value": gebiet_land},
            {"type": "in", "key": "TAXON_KEY", "values": [str(v) for v in FAMILIEN.values()]},
            {"type": "equals", "key": "HAS_COORDINATE", "value": "true"},
            {"type": "equals", "key": "HAS_GEOSPATIAL_ISSUE", "value": "false"},
            {"type": "equals", "key": "OCCURRENCE_STATUS", "value": "PRESENT"},
        ]},
    }
    if os.environ.get("GBIF_EMAIL"):
        anfrage["notificationAddresses"] = [os.environ["GBIF_EMAIL"]]
    req = urllib.request.Request(API + "occurrence/download/request", data=json.dumps(anfrage).encode(),
                                 headers={**UA, **auth, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        schluessel = r.read().decode().strip()
    print(f"GBIF-Download angefordert: {schluessel}", flush=True)
    # GBIF stellt den Download asynchron zusammen – das dauert Minuten bis eine halbe Stunde
    for _ in range(240):
        info = get(f"occurrence/download/{schluessel}")
        if info["status"] in ("SUCCEEDED", "FAILED", "KILLED", "CANCELLED"):
            break
        time.sleep(30)
    if info["status"] != "SUCCEEDED":
        sys.exit(f"GBIF-Download fehlgeschlagen: {info['status']}")
    print(f"Fertig: {info.get('totalRecords')} Datensaetze, {info.get('size', 0) / 1e6:.0f} MB, DOI {info.get('doi')}",
          flush=True)
    with urllib.request.urlopen(urllib.request.Request(info["downloadLink"], headers=UA), timeout=600) as r:
        zipdaten = r.read()
    titel = {}
    with zipfile.ZipFile(io.BytesIO(zipdaten)) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        with z.open(name) as f:
            leser = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"), delimiter="\t", quoting=csv.QUOTE_NONE)
            for x in leser:
                def zahl(feld, typ=float):
                    try:
                        return typ(x[feld]) if x.get(feld) else None
                    except ValueError:
                        return None
                dk = x.get("datasetKey")
                if dk and dk not in titel:
                    try:
                        titel[dk] = get(f"dataset/{dk}")["title"]
                    except Exception:  # noqa: BLE001
                        titel[dk] = ""
                yield {
                    "key": zahl("gbifID", int), "speciesKey": zahl("speciesKey", int), "species": x.get("species"),
                    "year": zahl("year", int), "month": zahl("month", int), "day": zahl("day", int),
                    "decimalLatitude": zahl("decimalLatitude"), "decimalLongitude": zahl("decimalLongitude"),
                    "coordinateUncertaintyInMeters": zahl("coordinateUncertaintyInMeters"),
                    "datasetKey": dk, "datasetName": titel.get(dk, ""), "license": x.get("license"),
                    "family": x.get("family"),
                }
    download.doi = info.get("doi")


def lizenz_kurz(url):
    u = (url or "").lower()
    if "publicdomain/zero" in u or "cc0" in u:
        return "CC0"
    for kuerzel, text in (("by-nc", "CC BY-NC"), ("by-sa", "CC BY-SA"), ("by", "CC BY")):
        if f"/{kuerzel}/" in u or u.endswith(kuerzel):
            return text + (" 4.0" if "4.0" in u else "")
    return url or "unbekannt"


def deutscher_name(key, cache):
    if str(key) in cache:
        return cache[str(key)]
    namen = []
    off = 0
    while True:
        r = get(f"species/{key}/vernacularNames", limit=100, offset=off)
        namen += [x["vernacularName"].strip() for x in r["results"] if x.get("language") in ("deu", "ger")]
        if r.get("endOfRecords", True):
            break
        off += 100
    # Haeufigste Schreibweise gewinnt; Grossschreibung vereinheitlichen
    name = None
    if namen:
        name = collections.Counter(n[:1].upper() + n[1:] for n in namen).most_common(1)[0][0]
    cache[str(key)] = name
    time.sleep(0.1)
    return name


def deutscher_name_ueber_epitheton(name, familie, cache):
    """Alte Gattungsnamen (Loweia tityrus) haben bei GBIF oft keinen deutschen
    Namen, die heute gueltige Kombination (Lycaena tityrus) schon. Gleiche Regel
    wie beim Zusammenfuehren: gleiche Familie + gleiches Epitheton."""
    epitheton = name.split()[-1]
    ck = f"ep:{familie}:{epitheton}"
    if ck in cache:
        return cache[ck]
    gefunden = None
    if familie in FAMILIEN:
        r = get("species/search", q=epitheton, rank="SPECIES", highertaxonKey=FAMILIEN[familie], limit=50)
        kandidaten = [x["key"] for x in r.get("results", [])
                      if (x.get("canonicalName") or "").split()[-1:] == [epitheton]]
        namen = collections.Counter(n for n in (deutscher_name(k, cache) for k in kandidaten[:12]) if n)
        gefunden = namen.most_common(1)[0][0] if namen else None
    cache[ck] = gefunden
    return gefunden


def block(jahr):
    return max(i for i, start in enumerate(BLOECKE) if jahr >= start)


def main(gebiete, per_download=False):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "b").mkdir(exist_ok=True)
    bezirke = json.loads((ROOT / "data" / "bezirke.geojson").read_text(encoding="utf-8"))["features"]

    def bezirk_genau(lat, lng):
        for f in bezirke:
            w, s, o, n = f["properties"]["bbox"]
            if w <= lng <= o and s <= lat <= n and any(
                    point_in_ring(lng, lat, p[0]) and not any(point_in_ring(lng, lat, h) for h in p[1:])
                    for p in f["geometry"]["coordinates"]):
                return f["properties"]["gkz"]
        return None

    # Punkt-in-Polygon fuer 700.000 Sichtungen dauert in Python ewig. Die Zuordnung
    # entscheidet nur, in welcher Bezirksdatei ein Punkt liegt (die App laedt
    # Nachbarbezirke mit) – daher je ~1-km-Zelle einmal rechnen.
    bezirk_memo = {}

    def bezirk_von(lat, lng):
        zelle = (round(lat, 2), round(lng, 2))
        if zelle not in bezirk_memo:
            bezirk_memo[zelle] = bezirk_genau(lat, lng) or bezirk_genau(*zelle)
        return bezirk_memo[zelle]

    def alle_datensaetze():
        if per_download:
            yield from download()
            return
        for gebiet in gebiete:
            print(f"{GEBIETE.get(gebiet, gebiet)} …", flush=True)
            yield from seiten(gebiet)

    # 1) Einlesen und grob filtern (als Tupel – bei ganz Oesterreich 700.000 Stueck)
    roh = 0
    verworfen = collections.Counter()
    daten = []
    namen = {}  # speciesKey -> (Name, Familie)
    for x in alle_datensaetze():
        roh += 1
        name = (x.get("species") or "").strip()
        teile = name.split()
        if not x.get("speciesKey") or len(teile) < 2 or len(teile[-1]) < 3:
            verworfen["nicht bis zur Art bestimmt"] += 1
            continue
        if not x.get("year"):
            verworfen["ohne Jahr"] += 1
            continue
        u = x.get("coordinateUncertaintyInMeters")
        if u and u > MAX_UNGENAU:
            verworfen[f"ungenauer als {MAX_UNGENAU} m"] += 1
            continue
        namen[x["speciesKey"]] = (name, x.get("family") or "")
        datum = f"{x['year']:04d}" + (f"-{x['month']:02d}" if x.get("month") else "") + (
            f"-{x['day']:02d}" if x.get("month") and x.get("day") else "")
        quelle = (x.get("datasetKey"), x.get("datasetName") or "", lizenz_kurz(x.get("license")))
        daten.append((x["speciesKey"], x["year"], datum, x["decimalLatitude"], x["decimalLongitude"], u,
                      x["key"], quelle))

    # 2) Dieselbe Art unter altem und neuem Gattungsnamen zusammenfuehren. GBIF fuehrt
    #    z. B. Mellicta athalia und Melitaea athalia als zwei Arten. Regel: gleiche
    #    Familie + gleiches Art-Epitheton = gleiche Art (Hesperia comma und Polygonia
    #    comma bleiben getrennt, verschiedene Familien).
    namen_cache_f = CACHE / "namen.json"
    namen_cache = json.loads(namen_cache_f.read_text(encoding="utf-8")) if namen_cache_f.exists() else {}
    anzahl_key = collections.Counter(d[0] for d in daten)
    gruppen = collections.defaultdict(list)
    for key, (name, familie) in namen.items():
        gruppen[(familie, name.split()[-1].lower())].append(key)
    print(f"{len(namen)} GBIF-Arten -> {len(gruppen)} nach Zusammenfuehren – deutsche Namen …", flush=True)
    kanon = {}   # speciesKey -> Vertreter
    art_info = {}  # Vertreter -> (wiss. Name, deutscher Name)
    for keys in gruppen.values():
        mit_name = [(k, deutscher_name(k, namen_cache)) for k in keys]
        # Vertreter: hat einen deutschen Namen, dann die meisten Datensaetze
        vertreter, dname = max(mit_name, key=lambda kn: (kn[1] is not None, anzahl_key[kn[0]]))
        for k_ in keys:
            kanon[k_] = vertreter
        if not dname:
            dname = deutscher_name_ueber_epitheton(*namen[vertreter], namen_cache)
        art_info[vertreter] = (namen[vertreter][0], dname)
        if len(keys) > 1:
            print(f"   zusammengefuehrt: {', '.join(namen[k_][0] for k_ in keys)} -> {namen[vertreter][0]}")
    namen_cache_f.write_text(json.dumps(namen_cache, ensure_ascii=False), encoding="utf-8")

    # 3) Doppelte Meldungen zusammenfassen: gleiche Art, gleicher Tag, ~100 m
    sicht = {}
    for key, jahr, datum, lat, lng, u, gid, quelle in daten:
        art = kanon[key]
        k = (art, datum, round(lat, 3), round(lng, 3))
        s_ = sicht.get(k)
        if s_:
            s_["quellen"].add(quelle)
            s_["n"] += 1
            if u and (s_["u"] is None or u < s_["u"]):
                s_["u"] = u
            continue
        sicht[k] = {"art": art, "jahr": jahr, "datum": datum, "lat": lat, "lng": lng, "u": u, "id": gid,
                    "quellen": {quelle}, "n": 1}
    del daten
    print(f"{roh} Datensaetze, {len(sicht)} Sichtungen nach Zusammenfassen; verworfen: {dict(verworfen)}")

    # --- Quellen (Datensatz + Lizenz) ---
    titel_cache = {}
    def titel(key, name):
        if name:
            return name
        if key not in titel_cache:
            try:
                titel_cache[key] = get(f"dataset/{key}")["title"]
            except Exception:  # noqa: BLE001
                titel_cache[key] = key
        return titel_cache[key]

    quellen = sorted({q for s in sicht.values() for q in s["quellen"]}, key=lambda q: (q[1], q[2]))
    q_index = {q: i for i, q in enumerate(quellen)}
    quellen_out = [{"key": q[0], "name": titel(q[0], q[1]), "lizenz": q[2]} for q in quellen]

    # --- Arten ---
    zaehler = collections.Counter(s_["art"] for s_ in sicht.values())
    arten = [{"k": key, "w": art_info[key][0], "d": art_info[key][1], "n": n} for key, n in zaehler.items()]
    arten.sort(key=lambda a_: (a_["d"] or a_["w"]).lower())
    a_index = {a_["k"]: i for i, a_ in enumerate(arten)}

    # --- Raster ---
    zellen = collections.defaultdict(lambda: collections.defaultdict(lambda: [0] * len(BLOECKE)))
    for s in sicht.values():
        r = int((s["lat"] - RASTER["lat0"]) // RASTER["dlat"])
        c = int((s["lng"] - RASTER["lng0"]) // RASTER["dlng"])
        zellen[(r, c)][a_index[s["art"]]][block(s["jahr"])] += 1
    raster = {**RASTER, "bloecke": BLOECKE,
              "z": [[r, c, [[a, *cnt] for a, cnt in sorted(arten_z.items())]]
                    for (r, c), arten_z in sorted(zellen.items())]}

    # --- Einzelsichtungen je Bezirk (spaltenweise) ---
    je_bezirk = collections.defaultdict(list)
    ausserhalb = 0
    for s in sicht.values():
        gkz = bezirk_von(s["lat"], s["lng"])
        if gkz:
            je_bezirk[gkz].append(s)
        else:
            ausserhalb += 1
    for alt in (OUT / "b").glob("*.json"):
        alt.unlink()
    for gkz, liste in je_bezirk.items():
        liste.sort(key=lambda s: (s["datum"], s["art"]))
        spalten = {
            "a": [a_index[s["art"]] for s in liste],
            "t": [s["datum"] for s in liste],
            "y": [round(s["lat"], 5) for s in liste],
            "x": [round(s["lng"], 5) for s in liste],
            "u": [round(s["u"]) if s["u"] else 0 for s in liste],
            "q": [sorted(q_index[q] for q in s["quellen"]) for s in liste],
            "i": [s["id"] for s in liste],
            "n": [s["n"] for s in liste],
        }
        (OUT / "b" / f"{gkz}.json").write_text(json.dumps(spalten, separators=(",", ":")), encoding="utf-8")

    heute = dt.date.today().isoformat()
    gebiet_namen = ["Österreich"] if per_download else [GEBIETE.get(g, g) for g in gebiete]
    doi = getattr(download, "doi", None) if per_download else None
    meta = {
        "stand": heute,
        "gebiete": gebiet_namen,
        "doi": doi,
        "bezirke": sorted(je_bezirk),
        "sichtungen": len(sicht), "datensaetze": roh,
        "quellen": quellen_out,
        "zitat": (f"GBIF.org ({heute}) GBIF Occurrence Download https://doi.org/{doi}" if doi else
                  f"GBIF.org ({heute}) GBIF Occurrence Search, Tagfalter (Papilionoidea) in "
                  f"{', '.join(gebiet_namen)}. https://www.gbif.org"),
    }
    for name, inhalt in (("meta.json", meta), ("arten.json", arten), ("raster.json", raster)):
        (OUT / name).write_text(json.dumps(inhalt, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    groesse = sum(p.stat().st_size for p in OUT.rglob("*.json"))
    print(f"Fertig: {len(arten)} Arten, {len(raster['z'])} Kaestchen, {len(je_bezirk)} Bezirke, "
          f"{ausserhalb} Sichtungen ausserhalb der Bezirksgrenzen, {groesse / 1024:.0f} KB")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    argumente = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(argumente or ["AUT.1_1"], per_download="--download" in sys.argv)
