"""
chronos_server.py - Local Chronos-2 forecast server for the dashboard.

Start it once (leave the window open while you use the dashboard):
    py chronos_server.py

The dashboard sends the monthly series it is showing to this server, which
runs Chronos-2 on them and sends the forecasts back. That makes Chronos work
for ANY dataset you upload; nothing needs to be pre-computed. Everything stays
on your computer (the server only listens on 127.0.0.1).

Options:
    --port   default 8765
    --model  default amazon/chronos-2
    --device cpu | cuda   (default cpu)
"""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import chronos_forecast as cf

MAX_SERIES = 64          # per request; the dashboard sends 2


def make_handler(predict_fn, model_id):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def _cors(self):
            # The dashboard may be opened from file:// or another local port.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if self.path.startswith("/health"):
                self._send(200, {"ok": True, "model": model_id,
                                 "horizon": cf.HORIZON})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if not self.path.startswith("/forecast"):
                return self._send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", 0))
                req = json.loads(self.rfile.read(n) or b"{}")
                series = req.get("series")
                if (not isinstance(series, list) or not series
                        or len(series) > MAX_SERIES):
                    return self._send(400, {"error": "bad 'series'"})
                clean = []
                for s in series:
                    if (not isinstance(s, list) or len(s) < 3
                            or not all(isinstance(x, (int, float)) for x in s)):
                        return self._send(400, {"error": "each series needs 3+ numbers"})
                    clean.append([float(x) for x in s])
                self._send(200, {"model": model_id, "forecasts": predict_fn(clean)})
            except Exception as e:                      # keep the server alive
                print("Request failed:", repr(e))
                self._send(500, {"error": str(e)})

        def log_message(self, fmt, *args):
            print("  " + (fmt % args))

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--model", default="amazon/chronos-2")
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()

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
