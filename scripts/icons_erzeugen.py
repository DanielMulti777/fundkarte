"""Erzeugt die App-Icons (PNG) ohne Fremdbibliothek: gruener Grund,
sandfarbene Kartennadel mit Blatt. Supersampling fuer weiche Kanten."""

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
GRUEN = (47, 93, 58)
SAND = (245, 242, 233)
MOOS = (107, 143, 71)


def png(path, w, h, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    path.write_bytes(data)


def farbe(u, v, rund, skala):
    """u, v in 0..1. Liefert RGBA fuer einen Abtastpunkt."""
    # Hintergrund: abgerundetes Quadrat (oder voll bei maskable)
    if rund:
        r = 0.22
        dx = max(abs(u - 0.5) - (0.5 - r), 0)
        dy = max(abs(v - 0.5) - (0.5 - r), 0)
        if dx * dx + dy * dy > r * r:
            return (0, 0, 0, 0)
    # Koordinaten um die Mitte skalieren (maskable braucht Sicherheitsrand)
    x = (u - 0.5) / skala + 0.5
    y = (v - 0.5) / skala + 0.5
    # Nadel: Kreis oben + Spitze unten
    cx, cy, rad = 0.5, 0.40, 0.25
    d = math.hypot(x - cx, y - cy)
    spitze_y = 0.86
    in_nadel = d <= rad
    if not in_nadel and cy <= y <= spitze_y:
        # Dreieck zwischen Tangentenpunkten und Spitze
        t = (y - cy) / (spitze_y - cy)
        breite = rad * 0.92 * (1 - t)
        in_nadel = abs(x - cx) <= breite
    if in_nadel:
        # Blatt in der Nadel: Schnittmenge zweier Kreise, schraeg
        a = math.radians(-35)
        lx = (x - cx) * math.cos(a) - (y - cy) * math.sin(a)
        ly = (x - cx) * math.sin(a) + (y - cy) * math.cos(a)
        if math.hypot(lx, ly - 0.09) < 0.15 and math.hypot(lx, ly + 0.09) < 0.15:
            if abs(lx) < 0.008 and abs(ly) < 0.06:
                return (*SAND, 255)  # Blattrippe
            return (*MOOS, 255)
        return (*SAND, 255)
    return (*GRUEN, 255)


def icon(groesse, name, rund=True, skala=1.0, ss=4):
    px = []
    for j in range(groesse):
        for i in range(groesse):
            acc = [0, 0, 0, 0]
            for sj in range(ss):
                for si in range(ss):
                    c = farbe((i + (si + .5) / ss) / groesse, (j + (sj + .5) / ss) / groesse, rund, skala)
                    a = c[3]
                    acc[0] += c[0] * a
                    acc[1] += c[1] * a
                    acc[2] += c[2] * a
                    acc[3] += a
            n = ss * ss
            alpha = acc[3] / n
            if acc[3]:
                px += [round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(alpha)]
            else:
                px += [0, 0, 0, 0]
    png(OUT / name, groesse, groesse, px)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    icon(192, "icon-192.png")
    icon(512, "icon-512.png", ss=2)
    icon(512, "icon-maskable-512.png", rund=False, skala=0.78, ss=2)
    print("Icons erzeugt")
