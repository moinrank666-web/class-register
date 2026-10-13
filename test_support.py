#!/usr/bin/env python3
"""End-to-end checks for the optional help assistant, with a stub provider.

test_api.py can only ever cover the *unconfigured* path, because the real key is a
secret the suite does not have — which is why a retired default model could sit
there failing unnoticed. This stands up a stub OpenAI-compatible endpoint plus a
second copy of the server pointed at it, and covers the rest: the Bearer header,
the payload shape, reply extraction, and how provider failures are surfaced.

Nothing here touches the network or needs a key.

Run:  python test_support.py
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "server.py")

results = []


def check(label, cond, detail=""):
    results.append((label, bool(cond), detail))
    print(("PASS  " if cond else "FAIL  ") + label + (("  -- " + str(detail)) if detail else ""))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class StubProvider(BaseHTTPRequestHandler):
    """Stands in for any OpenAI-compatible chat-completions endpoint."""

    mode = "ok"
    received = {}

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            self.received["payload"] = json.loads(raw or b"{}")
        except ValueError:
            self.received["payload"] = {}
        self.received["auth"] = self.headers.get("Authorization")
        self.received["path"] = self.path

        if self.mode == "http500":
            out, code = b'{"error":{"message":"stub upstream exploded"}}', 500
        elif self.mode == "model404":
            # What an OpenAI-compatible provider sends for a retired or unknown model.
            out = json.dumps({"error": {
                "message": "The model `stub-model` does not exist or you do not have access to it.",
                "type": "invalid_request_error", "code": "model_not_found"}}).encode()
            code = 404
        elif self.mode == "model400":
            # Same verdict, but a 400: some OpenAI-compatible providers answer an
            # unknown model this way instead of 404 (Groq uses 404).
            out = json.dumps({"error": {
                "message": "The model `stub-model` does not exist or you do not have access to it.",
                "type": "invalid_request_error", "code": "model_not_found"}}).encode()
            code = 400
        elif self.mode == "plain404":
            # A 404 that is NOT about the model — e.g. a wrong SUPPORT_API_URL.
            out, code = b'{"error":"Not Found"}', 404
        elif self.mode == "empty":
            out, code = b'{"choices":[]}', 200
        else:
            out = json.dumps({"choices": [{"message": {
                "role": "assistant", "content": "Open the Students screen and press Add."}}]}).encode()
            code = 200
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def start_stub(mode):
    StubProvider.mode = mode
    StubProvider.received = {}
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), StubProvider)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def start_app(support_url):
    env = dict(os.environ)
    port = free_port()
    env["ATTENDANCE_HOST"] = "127.0.0.1"
    env["ATTENDANCE_PORT"] = str(port)
    env["SUPPORT_API_KEY"] = "stub-key-12345"
    env["SUPPORT_MODEL"] = "stub-model"
    env["SUPPORT_API_URL"] = support_url
    proc = subprocess.Popen([sys.executable, SERVER], cwd=HERE, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    base = "http://127.0.0.1:%d" % port
    for _ in range(80):
        try:
            with urllib.request.urlopen(base + "/healthz", timeout=2) as res:
                if res.status == 200:
                    return proc, base
        except Exception:
            time.sleep(0.25)
    return proc, None


def post(base, path, payload, timeout=40):
    req = urllib.request.Request(
        base + path, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode() or "{}")


def run_mode(mode, support_url_for=None):
    """Point the app at a stub (or a dead port) and return (status, body)."""
    httpd, port = start_stub(mode)
    url = "http://127.0.0.1:8097/v1/chat/completions" if mode == "unreachable" \
        else "http://127.0.0.1:%d/v1/chat/completions" % port
    if support_url_for:
        url = support_url_for(port)
    proc, base = start_app(url)
    try:
        if base is None:
            check("[%s] server started with a key configured" % mode, False)
            return None, None
        return post(base, "/api/support", {"messages": [
            {"role": "user", "content": "How do I add a student?"}]})
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        httpd.shutdown()


def main():
    print("help assistant -- configured path (stub provider)")

    status, data = run_mode("ok")
    check("server started with a key configured", status is not None)
    check("assistant answers when a key is set",
          status == 200 and data.get("configured") is True and bool(data.get("reply")), data)
    check("reply text is passed through unchanged",
          data.get("reply") == "Open the Students screen and press Add.", data.get("reply"))
    check("key reaches the provider as a Bearer token",
          StubProvider.received.get("auth") == "Bearer stub-key-12345",
          StubProvider.received.get("auth"))
    check("provider is called at the configured path",
          StubProvider.received.get("path") == "/v1/chat/completions",
          StubProvider.received.get("path"))
    payload = StubProvider.received.get("payload") or {}
    check("SUPPORT_MODEL is forwarded", payload.get("model") == "stub-model", payload.get("model"))
    sent = payload.get("messages") or []
    check("system prompt is prepended",
          sent and sent[0].get("role") == "system" and "Academic Ledger" in (sent[0].get("content") or ""),
          sent[0].get("role") if sent else "no messages")
    check("the user's turn is sent last",
          sent[-1:] == [{"role": "user", "content": "How do I add a student?"}], sent[-1:])

    print("\nhelp assistant -- provider failures")
    status, data = run_mode("http500")
    check("a provider HTTP error becomes our own 502",
          status == 502 and "unavailable" in json.dumps(data).lower(), (status, data))

    status, data = run_mode("empty")
    check("an empty answer becomes a 502, not a blank bubble",
          status == 502 and bool(data.get("error")), (status, data))

    status, data = run_mode("unreachable")
    check("an unreachable provider becomes our own 502",
          status == 502 and "reached" in json.dumps(data).lower(), (status, data))

    print("\nhelp assistant -- a model the provider does not serve")
    status, data = run_mode("model404")
    check("a retired or unknown model is named as such, not reported as an outage",
          status == 502 and data.get("code") == "model_not_found", (status, data))
    check("the response says which model failed",
          data.get("model") == "stub-model", data.get("model"))
    check("the message names the model so an operator can act",
          "stub-model" in (data.get("error") or ""), data.get("error"))
    check("the provider's raw error body is not echoed to the browser",
          "invalid_request_error" not in (data.get("error") or ""), data.get("error"))

    status, data = run_mode("model400")
    check("the same rejection delivered as a 400 is named too",
          status == 502 and data.get("code") == "model_not_found"
          and data.get("model") == "stub-model", (status, data))

    status, data = run_mode("plain404")
    check("a 404 that is not about the model keeps the generic message",
          status == 502 and not data.get("code")
          and "unavailable" in json.dumps(data).lower(), (status, data))

    failed = [label for label, ok, _ in results if not ok]
    print("\n%d/%d checks passed" % (len(results) - len(failed), len(results)))
    if failed:
        print("failed: " + "; ".join(failed))
    return 1 if failed or not results else 0


if __name__ == "__main__":
    sys.exit(main())
