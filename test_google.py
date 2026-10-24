"""End-to-end check: Google sign-in role mapping + per-user data isolation.

A stub tokeninfo server plays Google's part (the server's GOOGLE_TOKENINFO_URL
is overridable exactly so this can be tested offline), then we sign in as an
admin, two teachers and a stranger, and assert who can see whose rows.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

APP = "127.0.0.1"
APP_PORT = 8801
STUB_PORT = 8802
CLIENT_ID = "stub-client-id.apps.googleusercontent.com"

passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {label}")
    else:
        failed += 1
        print(f"  FAIL {label}  {detail}")


class StubGoogle(BaseHTTPRequestHandler):
    """Returns claims for a token of the form 'role:<email>|aud:<id>|iss:x|vf:x'."""

    def log_message(self, *a):
        pass

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        tok = (qs.get("id_token") or [""])[0]
        if tok.startswith("http"):            # unreachable-url case -> Google's 400
            self.send_response(400)
            self.end_headers()
            return
        parts = dict(p.split(":", 1) for p in tok.split("|") if ":" in p)
        claims = {
            "email": parts.get("email", ""),
            "aud": parts.get("aud", CLIENT_ID),
            "iss": parts.get("iss", "https://accounts.google.com"),
            "email_verified": parts.get("vf", "true"),
        }
        body = json.dumps(claims).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def call(method, path, body=None, token=None, expect=200):
    url = f"http://{APP}:{APP_PORT}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, {"raw": raw}


def tok(email, aud=CLIENT_ID, iss="accounts.google.com", vf="true"):
    return f"email:{email}|aud:{aud}|iss:{iss}|vf:{vf}"


def main():
    stub = ThreadingHTTPServer(("127.0.0.1", STUB_PORT), StubGoogle)
    Thread(target=stub.serve_forever, daemon=True).start()

    tmp = tempfile.mkdtemp()
    db = os.path.join(tmp, "google_test.db")
    env = dict(os.environ,
               ATTENDANCE_DB=db, ATTENDANCE_PORT=str(APP_PORT), ATTENDANCE_HOST="127.0.0.1",
               GOOGLE_CLIENT_ID=CLIENT_ID,
               GOOGLE_ADMIN_EMAILS="boss@school.edu",
               GOOGLE_TEACHER_EMAILS="t1@school.edu,t2@school.edu",
               GOOGLE_TOKENINFO_URL=f"http://127.0.0.1:{STUB_PORT}/tokeninfo")
    proc = subprocess.Popen([sys.executable, "server.py"], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                if call("GET", "/healthz")[0] == 200:
                    break
            except Exception:
                pass
            time.sleep(0.5)

        print("google config")
        st, cfg = call("GET", "/api/auth/config")
        check("config is public and enabled", cfg.get("enabled") is True, str(cfg))
        check("config returns the client id", cfg.get("client_id") == CLIENT_ID, str(cfg))

        print("sign-in")
        st, adm = call("POST", "/api/auth/google", {"credential": tok("boss@school.edu")})
        check("admin gmail -> admin session", st == 200 and adm.get("role") == "admin", str(adm))
        st, t1 = call("POST", "/api/auth/google", {"credential": tok("t1@school.edu")})
        check("teacher 1 gmail -> teacher session", st == 200 and t1.get("role") == "teacher", str(t1))
        st, t2 = call("POST", "/api/auth/google", {"credential": tok("t2@school.edu")})
        check("teacher 2 gmail -> teacher session", st == 200 and t2.get("role") == "teacher", str(t2))

        st, stranger = call("POST", "/api/auth/google", {"credential": tok("nobody@x.com")})
        check("unknown gmail rejected 401", st == 401, str(stranger))
        st, wrongaud = call("POST", "/api/auth/google",
                            {"credential": tok("boss@school.edu", aud="other-app")})
        check("token for another app rejected", st == 401, str(wrongaud))
        st, badiss = call("POST", "/api/auth/google",
                          {"credential": tok("boss@school.edu", iss="evil.com")})
        check("forged issuer rejected", st == 401, str(badiss))
        st, unvf = call("POST", "/api/auth/google",
                        {"credential": tok("boss@school.edu", vf="false")})
        check("unverified email rejected", st == 401, str(unvf))
        st, empty = call("POST", "/api/auth/google", {})
        check("missing credential rejected", st == 401, str(empty))

        A, T1, T2 = adm["token"], t1["token"], t2["token"]
        st, me = call("GET", "/api/me", token=T1)
        check("/api/me carries the gmail", me.get("email") == "t1@school.edu", str(me))

        print("per-user isolation")
        st, r = call("POST", "/api/students",
                     {"name": "Alpha One", "grade": "5", "roll3": "001"}, token=T1)
        check("teacher 1 adds a student", st == 200, str(r))
        st, r = call("POST", "/api/students",
                     {"name": "Beta Two", "grade": "5", "roll3": "002"}, token=T2)
        check("teacher 2 adds a student", st == 200, str(r))

        st, mine = call("GET", "/api/students", token=T1)
        names1 = [s["name"] for s in mine["students"]]
        check("teacher 1 sees only their own row", names1 == ["Alpha One"], str(names1))

        st, theirs = call("GET", "/api/students", token=T2)
        names2 = [s["name"] for s in theirs["students"]]
        check("teacher 2 sees only their own row", names2 == ["Beta Two"], str(names2))

        st, allrows = call("GET", "/api/students", token=A)
        namesA = sorted(s["name"] for s in allrows["students"])
        check("admin sees every row", namesA == ["Alpha One", "Beta Two"], str(namesA))

        sid1 = [s["id"] for s in mine["students"]][0]
        sid2 = [s["id"] for s in theirs["students"]][0]
        st, r = call("GET", f"/api/student?id={sid2}", token=T1)
        check("teacher 1 cannot open teacher 2's student", st in (400, 404), f"{st} {r}")
        st, r = call("GET", f"/api/student?id={sid2}", token=A)
        check("admin can open any student", st == 200, str(st))

        print("tests & scores scoped")
        st, test1 = call("POST", "/api/tests",
                         {"name": "Unit Test 1", "month": "2026-10", "max_score": 25}, token=T1)
        check("teacher 1 creates a test", st == 200, str(test1))
        st, tests = call("GET", "/api/tests?month=2026-10", token=T2)
        check("teacher 2 cannot see teacher 1's test", tests.get("tests") == [], str(tests))
        st, tests = call("GET", "/api/tests?month=2026-10", token=A)
        check("admin sees the test", len(tests.get("tests", [])) == 1, str(tests))

        tid = test1["id"]
        st, r = call("POST", "/api/scores",
                     {"test_id": tid, "entries": [{"student_id": sid2, "score": 10}]}, token=T1)
        check("teacher 1 cannot score teacher 2's student", st in (400, 404), f"{st} {r}")
        st, r = call("POST", "/api/scores",
                     {"test_id": tid, "entries": [{"student_id": sid1, "score": 12}]}, token=T1)
        check("teacher 1 can score their own student", st == 200, str(r))

        print("admin manages who may sign in")
        st, r = call("POST", "/api/users",
                     {"email": "NewTeacher@School.edu", "role": "teacher"}, token=A)
        check("admin adds a teacher email", st == 200, str(r))
        st, r = call("POST", "/api/users",
                     {"email": "x@y.com", "role": "teacher"}, token=T1)
        check("teacher cannot manage users", st == 403, str(st))
        st, r = call("POST", "/api/auth/google", {"credential": tok("newteacher@school.edu")})
        check("newly added gmail can now sign in", st == 200 and r.get("role") == "teacher", str(r))
        st, r = call("DELETE", "/api/users?email=newteacher@school.edu", token=A)
        check("admin removes a teacher email", st == 200, str(r))
        st, r = call("POST", "/api/auth/google", {"credential": tok("newteacher@school.edu")})
        check("removed gmail is locked out again", st == 401, str(r))

        print("codes still work alongside")
        st, r = call("GET", "/api/status")
        check("status advertises google_enabled", r.get("google_enabled") is True, str(r))

        print(f"\n{passed} passed, {failed} failed")
        return 1 if failed else 0
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        stub.shutdown()


if __name__ == "__main__":
    sys.exit(main())
