"""
chronos_server.py - Local Chronos-2 forecast server for the dashboard.

Start it once (leave the window open while you use the dashboard):
    py chronos_server.py

The dashboard sends the monthly series it is showing to this server, which
runs Chronos-2 on them and sends the forecasts back. That makes Chronos work
for ANY dataset you upload; nothing needs to be pre-computed. Everything stays
on your computer: the server only listens on 127.0.0.1, and only accepts
browser requests from the origins listed in ALLOWED_ORIGINS.

Options:
    --port          default 8765
    --model         default amazon/chronos-2
    --device        cpu | cuda   (default cpu)
    --allow-origin  extra browser origin to accept (repeatable), e.g.
                    --allow-origin https://example.com
"""

import argparse
import json
import math
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import chronos_forecast as cf

MAX_SERIES = 64             # per request; the dashboard sends <= 64
MAX_POINTS = 2000           # per series; longer series keep their most recent points
MAX_BODY = 2_000_000        # bytes
SOCKET_TIMEOUT = 30         # seconds; a stalled client can't hold a thread forever

# Pages allowed to call the server from a browser. "null" = a file opened
# straight from disk. Requests with no Origin header (curl, scripts) are allowed.
ALLOWED_ORIGINS = {"null", "https://lukasv5.github.io"}
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")


def origin_allowed(origin):
    return (origin is None or origin in ALLOWED_ORIGINS
            or bool(LOCAL_ORIGIN.match(origin)))


def valid_number(x):
    # bool is a subclass of int in Python; NaN/inf would poison the model.
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def make_handler(predict_fn, model_id):
    lock = threading.Lock()  # one inference at a time: shared model, shared CPU

    class Handler(BaseHTTPRequestHandler):
        timeout = SOCKET_TIMEOUT

        def _origin(self):
            return self.headers.get("Origin")

        def _send(self, code, payload):
            body = json.dumps(payload, allow_nan=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def _cors(self):
            origin = self._origin()
            if origin is not None and origin_allowed(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def do_OPTIONS(self):
            if not origin_allowed(self._origin()):
                self.send_response(403)
                self.end_headers()
                return
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if not origin_allowed(self._origin()):
                return self._send(403, {"error": "origin not allowed"})
            if self.path.startswith("/health"):
                self._send(200, {"ok": True, "model": model_id, "horizon": cf.HORIZON})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            # Browsers always send Origin on cross-site POSTs (including the
            # "simple" text/plain kind that skips the preflight), so this stops
            # other websites from using your PC to run the model.
            if not origin_allowed(self._origin()):
                return self._send(403, {"error": "origin not allowed"})
            if not self.path.startswith("/forecast"):
                return self._send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "-1"))
            except ValueError:
                n = -1
            if n < 0 or n > MAX_BODY:
                return self._send(413 if n > MAX_BODY else 411, {"error": "missing or too large body"})
            try:
                req = json.loads(self.rfile.read(n) or b"{}")
            except Exception:
                return self._send(400, {"error": "body is not valid JSON"})
            series = req.get("series") if isinstance(req, dict) else None
            if not isinstance(series, list) or not series or len(series) > MAX_SERIES:
                return self._send(400, {"error": f"'series' must be a list of 1-{MAX_SERIES} series"})
            clean = []
            for s in series:
                if not isinstance(s, list) or len(s) < 3 or not all(valid_number(x) for x in s):
                    return self._send(400, {"error": "each series needs 3+ finite numbers"})
                clean.append([float(x) for x in s[-MAX_POINTS:]])
            try:
                with lock:
                    forecasts = predict_fn(clean)
                self._send(200, {"model": model_id, "forecasts": forecasts})
            except Exception as e:                      # keep the server alive
                print("Request failed:", repr(e))
                self._send(500, {"error": "forecast failed: " + str(e)[:200]})

        def log_message(self, fmt, *args):
            print("  " + (fmt % args))

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--model", default="amazon/chronos-2")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--allow-origin", action="append", default=[])
    args = ap.parse_args()
    ALLOWED_ORIGINS.update(o.rstrip("/") for o in args.allow_origin)

    pipeline = cf.load_pipeline(args.model, args.device)
    handler = make_handler(lambda s: cf.predict_batch(pipeline, s), args.model)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Chronos-2 server ready on http://127.0.0.1:{args.port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
