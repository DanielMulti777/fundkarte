"""Holt Bezirks- und Gemeindegrenzen fuer ganz Oesterreich aus OpenStreetMap
(Overpass), vereinfacht sie und schreibt:

  data/bezirke.geojson            alle Bezirke (inkl. Statutarstaedte, Wien als ein Bezirk)
  data/gemeinden/<gkz>.geojson    Gemeinden je Bezirk (Wien: Gemeindebezirke)

Einmalig ausfuehren; das Ergebnis wird eingecheckt, damit die App ohne
Overpass und offline funktioniert. Pro Bundesland eine Abfrage, mit Pause,
damit der oeffentliche Overpass-Dienst nicht ueberlastet wird.

Daten: (c) OpenStreetMap-Mitwirkende, ODbL.
"""

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
UA = "fundkarte/1.0 (private Naturbeobachtung, einmaliger Grenzen-Abruf)"
OUT = Path(__file__).resolve().parent.parent / "data"
CACHE = Path(__file__).resolve().parent / ".cache"

LAENDER = [
    "Burgenland", "Kärnten", "Niederösterreich", "Oberösterreich", "Salzburg",
    "Steiermark", "Tirol", "Vorarlberg", "Wien",
]
# Toleranz in Grad: ~25 m fuer die Uebersicht, ~8 m fuer Gemeinden
TOL_BEZIRK = 0.0003
TOL_GEMEINDE = 0.0001


def overpass(query, cache_name):
    CACHE.mkdir(exist_ok=True)
    cf = CACHE / cache_name
    if cf.exists():
        return json.loads(cf.read_text(encoding="utf-8"))
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for versuch in range(6):
        ep = ENDPOINTS[versuch % len(ENDPOINTS)]
        try:
            req = urllib.request.Request(ep, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                raw = r.read().decode("utf-8")
            res = json.loads(raw)
            cf.write_text(raw, encoding="utf-8")
            return res
        except Exception as e:  # noqa: BLE001 - jeder Fehler -> naechster Server
            last = e
            print(f"   {ep}: {e} – neuer Versuch", flush=True)
            time.sleep(10 + versuch * 10)
    raise RuntimeError(f"Overpass nicht erreichbar: {last}")


def rings_from_ways(ways):
    """Setzt lose OSM-Wegsegmente (Richtung beliebig) zu geschlossenen Ringen zusammen."""
    segs = [[(p["lon"], p["lat"]) for p in w["geometry"]] for w in ways if w.get("geometry")]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def dp(points, tol):
    """Douglas-Peucker, iterativ (rekursiv sprengt bei langen Grenzen den Stack)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if norm == 0:
                d = ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


def simplify_ring(ring, tol):
    # Geschlossener Ring: am entferntesten Punkt teilen, sonst kollabiert er
    x0, y0 = ring[0]
    far = max(range(len(ring)), key=lambda i: (ring[i][0] - x0) ** 2 + (ring[i][1] - y0) ** 2)
    a = dp(ring[: far + 1], tol)
    b = dp(ring[far:], tol)
    out = a + b[1:]
    if len(out) < 4:
        return None
    return [[round(x, 5), round(y, 5)] for x, y in out]


def ring_area(r):
    return abs(sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1))) / 2


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def geometry(rel, tol):
    ways = [m for m in rel["members"] if m["type"] == "way"]
    outer = rings_from_ways([m for m in ways if m.get("role") in ("outer", "")])
    inner = rings_from_ways([m for m in ways if m.get("role") == "inner"])
    polys = []
    for o in outer:
        so = simplify_ring(o, tol)
        if so:
            polys.append([so])
    for i in inner:
        si = simplify_ring(i, tol)
        if not si:
            continue
        for p in polys:
            if point_in_ring(si[0][0], si[0][1], p[0]):
                p.append(si)
                break
    polys.sort(key=lambda p: -ring_area(p[0]))
    return {"type": "MultiPolygon", "coordinates": polys} if polys else None


def bbox(geom):
    pts = [p for poly in geom["coordinates"] for r in poly for p in r]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def flaeche(geom):
    a = 0.0
    for poly in geom["coordinates"]:
        for k, r in enumerate(poly):
            a += ring_area(r) * (1 if k == 0 else -1)
    return a


def nachtrag(bezirke, gemeinden_je_bezirk):
    """Die Landes-Abfrage liefert nicht immer alle Gemeinden (2026: Soelden fehlte,
    falsch getaggt). Wo die Gemeinden den Bezirk nicht fuellen, wird der Bezirk
    einzeln abgefragt und Fehlendes ergaenzt."""
    for b in bezirke:
        p = b["properties"]
        feats = gemeinden_je_bezirk.get(p["gkz"], [])
        if not feats or p["land"] == "Wien":
            continue
        anteil = sum(flaeche(f["geometry"]) for f in feats) / flaeche(b["geometry"])
        if anteil > 0.97:
            continue
        print(f"Nachtrag {p['name']} ({anteil:.0%} abgedeckt) …", flush=True)
        # Ueber die Gemeindekennziffer statt ueber boundary-Tags: 2026 war Soelden
        # (GKZ 70220) in OSM faelschlich als route=piste getaggt und fiel so durch.
        q = f"""
[out:json][timeout:180];
relation["ref:at:gkz"~"^{p['gkz']}[0-9][0-9]$"];
out geom;
"""
        res = overpass(q, f"bezirk-gkz-{p['gkz']}.json")
        vorhanden = {f["properties"]["name"] for f in feats}
        for r in res["elements"]:
            name = r["tags"].get("name")
            if r["type"] != "relation" or name in vorhanden or r["tags"].get("ref:at:gkz") in {
                    f["properties"]["gkz"] for f in feats}:
                continue
            g = geometry(r, TOL_GEMEINDE)
            if not g:
                continue
            feats.append({"type": "Feature", "properties": {"gkz": gkz(r["tags"]), "name": name},
                          "geometry": g})
            print(f"   + {name}")
        time.sleep(3)


def gkz(tags):
    return (tags.get("ref:at:gkz") or "").strip()


def main():
    bezirke = []
    gemeinden_je_bezirk = {}
    for land in LAENDER:
        print(f"{land} …", flush=True)
        q = f"""
[out:json][timeout:280];
area["ISO3166-1"="AT"]["admin_level"="2"]->.at;
relation(area.at)["boundary"="administrative"]["admin_level"="4"]["name"="{land}"]->.land;
.land map_to_area->.la;
(
  .land;
  relation(area.la)["boundary"="administrative"]["admin_level"~"^(6|8|9)$"];
);
out geom;
"""
        res = overpass(q, f"{land}.json")
        rels = [e for e in res["elements"] if e["type"] == "relation"]

        def lvl(r):
            return r["tags"].get("admin_level")

        lands = [r for r in rels if lvl(r) == "4"]
        b6 = [r for r in rels if lvl(r) == "6"]
        g8 = [r for r in rels if lvl(r) == "8"]
        if land == "Wien":
            # Wien ist Land, Bezirk und Gemeinde zugleich; feiner sind nur die Gemeindebezirke
            b6 = lands[:1]
            g8 = [r for r in rels if lvl(r) == "9"]
        land_bez = []
        for r in b6:
            g = geometry(r, TOL_BEZIRK)
            if not g:
                print("   ! keine Geometrie:", r["tags"].get("name"))
                continue
            k = "900" if land == "Wien" else (gkz(r["tags"]) or f"x{r['id']}")
            land_bez.append({
                "type": "Feature",
                "properties": {"gkz": k, "name": r["tags"].get("name"), "land": land,
                               "bbox": bbox(g), "_osm": r["id"]},
                "geometry": g,
            })
        for r in g8:
            g = geometry(r, TOL_GEMEINDE)
            if not g:
                continue
            gk = gkz(r["tags"])
            ziel = None
            if land == "Wien":
                ziel = "900"
            elif len(gk) >= 3 and any(b["properties"]["gkz"] == gk[:3] for b in land_bez):
                ziel = gk[:3]
            else:
                # Fallback: Mittelpunkt der Bbox im Bezirk suchen
                bb = bbox(g)
                cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
                for b in land_bez:
                    if any(point_in_ring(cx, cy, p[0]) for p in b["geometry"]["coordinates"]):
                        ziel = b["properties"]["gkz"]
                        break
            if not ziel:
                print("   ! Gemeinde ohne Bezirk:", r["tags"].get("name"))
                continue
            gemeinden_je_bezirk.setdefault(ziel, []).append({
                "type": "Feature",
                "properties": {"gkz": gk, "name": r["tags"].get("name")},
                "geometry": g,
            })
        print(f"   {len(land_bez)} Bezirke, {len(g8)} Gemeinden", flush=True)
        bezirke += land_bez
        time.sleep(5)

    nachtrag(bezirke, gemeinden_je_bezirk)

    OUT.mkdir(exist_ok=True)
    (OUT / "gemeinden").mkdir(exist_ok=True)
    # Statutarstaedte ohne eigene Gemeinde-Relation: Bezirk selbst ist die Gemeinde
    for b in bezirke:
        k = b["properties"]["gkz"]
        feats = gemeinden_je_bezirk.get(k) or [{
            "type": "Feature",
            "properties": {"gkz": k, "name": b["properties"]["name"]},
            "geometry": b["geometry"],
        }]
        b["properties"]["gemeinden"] = len(feats)
        feats.sort(key=lambda f: f["properties"]["name"] or "")
        (OUT / "gemeinden" / f"{k}.geojson").write_text(
            json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False,
                       separators=(",", ":")),
            encoding="utf-8",
        )
    for b in bezirke:
        b["properties"].pop("_osm", None)
    bezirke.sort(key=lambda f: (f["properties"]["land"], f["properties"]["name"]))
    (OUT / "bezirke.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": bezirke}, ensure_ascii=False,
                   separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Fertig: {len(bezirke)} Bezirke, "
          f"{sum(b['properties']['gemeinden'] for b in bezirke)} Gemeinden")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
