"""Kleiner Vorschau-Server fuer Tests (auch hinter einem https-Tunnel).

Anders als `python -m http.server`: keine Ordnerlisten, keine versteckten
Dateien (.git, .cache …), keine Skripte – nur das, was die App braucht.
Aufruf: python scripts/server.py [port]
"""

import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ERLAUBT = ("index.html", "app.css", "sw.js", "manifest.webmanifest", "js/", "vendor/", "data/", "icons/")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".geojson": "application/geo+json",
        ".js": "text/javascript",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def send_head(self):
        pfad = self.path.split("?", 1)[0].split("#", 1)[0].lstrip("/")
        if pfad == "":
            pfad = "index.html"
        if "/." in "/" + pfad or ".." in pfad or not pfad.startswith(ERLAUBT) or pfad.endswith("/"):
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        # Beim Testen sollen Aenderungen sofort ankommen; den Rest macht der Service Worker
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4330
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
