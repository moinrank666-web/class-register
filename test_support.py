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
import tempfile
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
    calls = []          # every chat request, so a test can see what was tried and in what order
    models = ["stub-model", "backup-model"]   # what GET /models reports
    models_status = 200                       # set to 500 to simulate an unreachable provider

    def log_message(self, *a):
        pass

    def do_GET(self):
        """The provider's model list — what the admin diagnostics panel probes."""
        if not self.path.rstrip("/").endswith("/models"):
            self.send_error(404)
            return
        if self.models_status != 200:
            out, code = b'{"error":"model list unavailable"}', self.models_status
        else:
            out = json.dumps({"data": [{"id": m} for m in self.models]}).encode()
            code = 200
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            self.received["payload"] = json.loads(raw or b"{}")
        except ValueError:
            self.received["payload"] = {}
        self.received["auth"] = self.headers.get("Authorization")
        self.received["path"] = self.path
        self.calls.append({"model": (self.received["payload"] or {}).get("model"),
                           "path": self.path})

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
        elif self.mode == "fallback":
            # Serves every model except "stub-model", which stands in for one the
            # provider has retired. The reply names the model, so a test can tell
            # which one actually answered.
            served = (self.received["payload"] or {}).get("model")
            if served == "stub-model":
                out = json.dumps({"error": {
                    "message": "The model `stub-model` does not exist or you do not have access to it.",
                    "type": "invalid_request_error", "code": "model_not_found"}}).encode()
                code = 404
            else:
                out = json.dumps({"choices": [{"message": {
                    "role": "assistant", "content": "Answered by " + str(served)}}]}).encode()
                code = 200
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
    StubProvider.calls = []
    StubProvider.models_status = 500 if mode == "models500" else 200
    StubProvider.models = [] if mode == "models-missing" else ["stub-model", "backup-model"]
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), StubProvider)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def start_app(support_url, extra_env=None):
    env = dict(os.environ)
    port = free_port()
    env["ATTENDANCE_HOST"] = "127.0.0.1"
    env["ATTENDANCE_PORT"] = str(port)
    env["SUPPORT_API_KEY"] = "stub-key-12345"
    env["SUPPORT_MODEL"] = "stub-model"
    env["SUPPORT_API_URL"] = support_url
    # The developer's own environment must not decide this: the shipped default
    # applies unless a test asks for something else.
    env.pop("SUPPORT_FALLBACK_MODEL", None)
    env.update(extra_env or {})
    # Keep runs off the repo's own database; a fresh file also means /api/setup is
    # available, which the admin diagnostics checks need in order to sign in.
    env["ATTENDANCE_DB"] = os.path.join(tempfile.gettempdir(), "al_support_%d.db" % port)
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


def get(base, path, token=None, timeout=40):
    req = urllib.request.Request(base + path)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode() or "{}"
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {}


def setup_admin(base):
    """Create the three codes and return an admin token, or None."""
    req = urllib.request.Request(base + "/api/setup", data=json.dumps({
        "admin_code": "admin-pass-1", "teacher_code": "teach-pass-2",
        "observer_code": "watch-pass-3"}).encode(), method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode()).get("token")
    except Exception:
        return None


def login(base, role, code):
    req = urllib.request.Request(base + "/api/login", data=json.dumps(
        {"role": role, "code": code}).encode(), method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode()).get("token")
    except Exception:
        return None


class Harness:
    """A stub provider plus a copy of the app pointed at it, torn down on exit."""

    def __init__(self, mode, extra_env=None):
        self.httpd, self.port = start_stub(mode)
        self.proc, self.base = start_app(
            "http://127.0.0.1:%d/v1/chat/completions" % self.port, extra_env)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        self.httpd.shutdown()


def run_mode(mode, support_url_for=None, extra_env=None):
    """Point the app at a stub (or a dead port) and return (status, body)."""
    httpd, port = start_stub(mode)
    url = "http://127.0.0.1:8097/v1/chat/completions" if mode == "unreachable" \
        else "http://127.0.0.1:%d/v1/chat/completions" % port
    if support_url_for:
        url = support_url_for(port)
    proc, base = start_app(url, extra_env)
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

    print("\nhelp assistant -- a retired model falls back instead of failing")
    status, data = run_mode("fallback", extra_env={"SUPPORT_FALLBACK_MODEL": "backup-model"})
    check("a question is still answered when the configured model is retired",
          status == 200 and data.get("reply") == "Answered by backup-model", (status, data))
    check("the retired model is tried first, then the fallback",
          [c["model"] for c in StubProvider.calls] == ["stub-model", "backup-model"],
          StubProvider.calls)
    check("the reply reports which model actually served it",
          data.get("model") == "backup-model", data.get("model"))

    # The default must be a real fallback, so assert it is used without naming it here.
    status, data = run_mode("fallback")
    check("the shipped default applies when no fallback is configured",
          status == 200 and data.get("model") and data.get("model") != "stub-model",
          (status, data))

    # Two questions on one server: the second must not retry the dead model.
    httpd, port = start_stub("fallback")
    proc, base = start_app("http://127.0.0.1:%d/v1/chat/completions" % port,
                           {"SUPPORT_FALLBACK_MODEL": "backup-model"})
    try:
        check("server started for the repeat-question check", base is not None)
        first = post(base, "/api/support", {"messages": [{"role": "user", "content": "one"}]})
        second = post(base, "/api/support", {"messages": [{"role": "user", "content": "two"}]})
        check("both questions are answered",
              first[0] == 200 and second[0] == 200, (first, second))
        check("the second question skips the model the provider does not serve",
              [c["model"] for c in StubProvider.calls]
              == ["stub-model", "backup-model", "backup-model"], StubProvider.calls)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        httpd.shutdown()

    status, data = run_mode("model404", extra_env={"SUPPORT_FALLBACK_MODEL": "backup-model"})
    check("when the fallback is unknown too, the configured model is the one still named",
          status == 502 and data.get("code") == "model_not_found"
          and data.get("model") == "stub-model", (status, data))

    status, data = run_mode("model404", extra_env={"SUPPORT_FALLBACK_MODEL": ""})
    check("an empty SUPPORT_FALLBACK_MODEL disables the retry",
          status == 502 and data.get("code") == "model_not_found"
          and len(StubProvider.calls) == 1, (status, data, StubProvider.calls))

    status, data = run_mode("model404", extra_env={"SUPPORT_FALLBACK_MODEL": "stub-model"})
    check("a fallback identical to the configured model is not retried",
          status == 502 and len(StubProvider.calls) == 1, (status, data, StubProvider.calls))

    print("\nhelp assistant -- admin diagnostics")
    with Harness("ok") as h:
        check("server started for the diagnostics check", h.base is not None)
        code, _ = get(h.base, "/api/support/diagnostics")
        check("diagnostics needs a session", code == 401, code)
        admin = setup_admin(h.base)
        check("admin session for the diagnostics check", bool(admin))
        teacher = login(h.base, "teacher", "teach-pass-2")
        code, _ = get(h.base, "/api/support/diagnostics", teacher)
        check("a teacher may not read diagnostics", code == 403, code)
        status, d = get(h.base, "/api/support/diagnostics", admin)
        check("an admin reads diagnostics", status == 200 and d.get("enabled") is True,
              (status, d))
        check("diagnostics reports the configured model",
              d.get("configured_model") == "stub-model", d.get("configured_model"))
        check("diagnostics reports the model actually in use",
              d.get("in_use_model") == "stub-model", d.get("in_use_model"))
        check("diagnostics confirms the provider is reachable",
              d.get("provider_reachable") is True, d.get("provider_reachable"))
        check("diagnostics confirms the provider serves our model",
              d.get("model_available") is True, d.get("model_available"))
        check("a healthy deployment reports no error",
              not d.get("provider_error") and not d.get("last_error"), d)
        check("diagnostics never echoes the key",
              "api_key" not in json.dumps(d).lower()
              and "bearer" not in json.dumps(d).lower(), d)

    with Harness("models500") as h:
        admin = setup_admin(h.base)
        _, d = get(h.base, "/api/support/diagnostics", admin)
        check("diagnostics report an unreachable provider",
              d.get("provider_reachable") is False, d.get("provider_reachable"))
        check("diagnostics say why the provider could not be read",
              "500" in str(d.get("provider_error")), d.get("provider_error"))
        check("an unread model list leaves availability unknown",
              d.get("model_available") is None, d.get("model_available"))

    with Harness("models-missing") as h:
        admin = setup_admin(h.base)
        _, d = get(h.base, "/api/support/diagnostics", admin)
        check("diagnostics flag a model the provider no longer lists",
              d.get("provider_reachable") is True and d.get("model_available") is False, d)

    # After a fallback has answered, the panel must show the model in use and the
    # reason the configured one was abandoned.
    with Harness("fallback", {"SUPPORT_FALLBACK_MODEL": "backup-model"}) as h:
        admin = setup_admin(h.base)
        post(h.base, "/api/support", {"messages": [{"role": "user", "content": "hello"}]})
        _, d = get(h.base, "/api/support/diagnostics", admin)
        check("diagnostics report the model actually answering",
              d.get("using_fallback") is True and d.get("in_use_model") == "backup-model",
              (d.get("using_fallback"), d.get("in_use_model")))
        check("diagnostics still report what is configured",
              d.get("configured_model") == "stub-model", d.get("configured_model"))
        check("diagnostics surface the last provider error",
              "404" in str((d.get("last_error") or {}).get("kind")), d.get("last_error"))

    failed = [label for label, ok, _ in results if not ok]
    print("\n%d/%d checks passed" % (len(results) - len(failed), len(results)))
    if failed:
        print("failed: " + "; ".join(failed))
    return 1 if failed or not results else 0


if __name__ == "__main__":
    sys.exit(main())
