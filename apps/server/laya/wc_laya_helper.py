"""
Work Commander's local Laya helper.

A small HTTP server, bound to 127.0.0.1 and protected by a per-run bearer token, around Laya's Python library
(the "vegaml" VegaAgent, the only Laya mode that can be trained on examples). Work Commander starts and stops it.

Message text it receives is only ever classified, never executed or followed.

Endpoints (JSON):
  GET  /health                      -> {"ok": true, "laya": "<version>", "loaded": bool}
  POST /min_rows   {questions}      -> {"rows": n}
  POST /predict    {state, questions, heads}       -> Laya's answers ("heads" = folder of a trained version)
  POST /fit        {rows, questions, out}          -> Laya's fit report; the trained heads are saved to "out"

Environment: WC_LAYA_PORT, WC_LAYA_TOKEN, HF_HUB_CACHE (model download cache).
"""
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("WC_LAYA_PORT", "0"))
TOKEN = os.environ.get("WC_LAYA_TOKEN", "")
MAX_BODY = 8 * 1024 * 1024

if not PORT or not TOKEN:
    print("WC_LAYA_PORT and WC_LAYA_TOKEN are required", file=sys.stderr)
    sys.exit(2)

import laya  # noqa: E402  (imported after the checks so a misconfigured start fails fast)

_lock = threading.Lock()  # one model, one request at a time
_agent = None
_heads = None  # folder of the heads currently loaded


def agent():
    global _agent
    if _agent is None:
        _agent = laya.VegaAgent()
    return _agent


def use_heads(path):
    """Load a trained version's heads, unless it is already loaded."""
    global _heads
    if path == _heads:
        return
    if not path or not os.path.isdir(path):
        raise ValueError("trained heads not found: %s" % path)
    agent().load_calibration(path)
    _heads = path


def jsonable(v):
    return json.loads(json.dumps(v, default=str))


class Handler(BaseHTTPRequestHandler):
    server_version = "wc-laya/1"

    def log_message(self, fmt, *args):  # keep message text out of logs
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        got = self.headers.get("Authorization", "")
        return hmac.compare_digest(got, "Bearer " + TOKEN)

    def do_GET(self):
        if not self.authorized():
            return self.reply(401, {"error": "unauthorized"})
        if self.path == "/health":
            return self.reply(200, {"ok": True, "laya": getattr(laya, "__version__", "?"), "loaded": _agent is not None})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorized():
            return self.reply(401, {"error": "unauthorized"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self.reply(413, {"error": "request too large"})
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.reply(400, {"error": "invalid JSON"})
        try:
            with _lock:
                if self.path == "/min_rows":
                    return self.reply(200, {"rows": laya.VegaAgent.min_rows(body["questions"])})
                if self.path == "/predict":
                    use_heads(body.get("heads"))
                    t = time.time()
                    out = agent().predict(body["state"], body["questions"])
                    return self.reply(200, {"answers": jsonable(out.get("answers", {})), "ms": round((time.time() - t) * 1000, 1)})
                if self.path == "/fit":
                    global _heads
                    a = agent()
                    report = a.fit(body["rows"], questions=body["questions"])
                    os.makedirs(body["out"], exist_ok=True)
                    a.save_calibration(body["out"])
                    _heads = body["out"]
                    return self.reply(200, {"report": jsonable(report)})
            self.reply(404, {"error": "not found"})
        except Exception as e:  # report, don't crash the helper
            self.reply(500, {"error": "%s: %s" % (type(e).__name__, str(e)[:500])})


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    # Load the model before announcing readiness, so the first triage call isn't the slow one.
    agent()
    print("WC_LAYA_READY", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
