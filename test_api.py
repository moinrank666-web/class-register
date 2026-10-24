#!/usr/bin/env python3
"""End-to-end checks against a running server (python server.py)."""
import csv
import io
import json
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
ADMIN_CODE = "admin-pass-1"
TEACHER_CODE = "teach-pass-2"
OBSERVER_CODE = "watch-pass-3"
FAILURES = []

# Access codes are stored as PBKDF2-SHA256 hashes at 600,000 iterations — slow on
# purpose, and /api/setup hashes three codes at once. That is 7s even on an idle
# machine and more under load, so the transport must be patient: this is a limit on
# how long the client waits, not an assertion about how fast the app should be.
CALL_TIMEOUT = 90


def call(method, path, body=None, token=None, expect=200):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=CALL_TIMEOUT) as res:
            raw = res.read().decode("utf-8-sig" if path.startswith("/api/export") else "utf-8")
            status = res.status
            ctype = res.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        status = e.code
        ctype = e.headers.get("Content-Type", "")
    payload = json.loads(raw) if "json" in ctype else raw
    if status != expect:
        FAILURES.append(f"{method} {path} -> {status} (expected {expect}): {payload}")
    return payload


def check(label, cond, detail=""):
    if cond:
        print(f"  ok   {label}")
    else:
        FAILURES.append(f"{label} {detail}")
        print(f"  FAIL {label} {detail}")


def probe(path):
    """Status + content-type + CSP without reading the (possibly binary) body."""
    try:
        with urllib.request.urlopen(BASE + path, timeout=10) as r:
            return r.status, r.headers.get("Content-Type", ""), r.headers.get("Content-Security-Policy", "")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.headers.get("Content-Security-Policy", "")


def headers_of(path, method="GET"):
    """Response headers only, case-insensitive lookup (HTTPMessage.get)."""
    req = urllib.request.Request(BASE + path, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.headers


def main():
    print("static")
    html = call("GET", "/")
    check("index.html served", isinstance(html, str) and "Academic Ledger" in html)

    print("indexing")
    check("index declares canonical URL", 'rel="canonical"' in html)
    check("index allows indexing", 'name="robots"' in html and "index, follow" in html)
    check("index has Search Console token slot", "google-site-verification" in html)
    check("index ships JSON-LD schema", html.count("application/ld+json") >= 2)
    rb = call("GET", "/robots.txt")
    check("robots.txt points at sitemap",
          isinstance(rb, str) and
          "Sitemap: https://class-register-cudp.onrender.com/sitemap.xml" in rb)
    # A single `Disallow: /` (or a bare leading slash pattern) would block the
    # whole site — the exact thing Search Console reports as "blocked by
    # robots.txt". Guard against it ever reappearing.
    check("robots.txt allows the whole site",
          isinstance(rb, str) and "Allow: /" in rb
          and not re.search(r"(?im)^\s*disallow:\s*/\s*$", rb), str(rb))
    check("robots.txt blocks no path at all",
          isinstance(rb, str) and not re.search(r"(?im)^\s*disallow:\s*\S", rb),
          str(rb))
    st, ct, _ = probe("/robots.txt")
    check("robots.txt served as plain text", st == 200 and "text/plain" in ct,
          f"{st} {ct}")

    print("monitoring")
    st, ct, _ = probe("/healthz")
    check("/healthz answers 200 as text/plain", st == 200 and "text/plain" in ct,
          f"{st} {ct}")
    check("/healthz needs no sign-in and returns a bare ok",
          call("GET", "/healthz").strip() == "ok")
    st, hz = headers_of("/healthz")
    check("/healthz tells the monitor which app answered",
          "AttendanceRegister" in (hz.get("Server") or ""), str(hz.get("Server")))
    check("/healthz is never cached or indexed",
          "no-store" in (hz.get("Cache-Control") or "")
          and "noindex" in (hz.get("X-Robots-Tag") or ""),
          f"{hz.get('Cache-Control')} / {hz.get('X-Robots-Tag')}")
    st, _ = headers_of("/healthz", method="HEAD")
    check("/healthz answers HEAD (Render's own port probe)", st == 200, str(st))
    sm = call("GET", "/sitemap.xml")
    locs = []
    if isinstance(sm, str):
        try:
            root = ET.fromstring(sm)
            ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
            for u in root.findall(ns + "url"):
                loc = u.find(ns + "loc")
                if loc is not None and loc.text:
                    locs.append(loc.text)
        except ET.ParseError:
            locs = []
    check("sitemap.xml valid, points at canonical home",
          locs == ["https://class-register-cudp.onrender.com/"], str(locs))

    print("pwa")
    mf = call("GET", "/manifest.webmanifest")
    check("manifest served as JSON", isinstance(mf, dict), str(type(mf)))
    check("manifest names the app",
          isinstance(mf, dict) and str(mf.get("name", "")).startswith("Academic Ledger"),
          str(mf.get("name")) if isinstance(mf, dict) else "")
    check("manifest install fields",
          isinstance(mf, dict) and mf.get("display") == "standalone"
          and mf.get("start_url") == "/" and mf.get("scope") == "/",
          str({k: mf.get(k) for k in ("display", "start_url", "scope")}
              if isinstance(mf, dict) else None))
    icons = mf.get("icons", []) if isinstance(mf, dict) else []
    sizes = {i.get("sizes") for i in icons}
    purposes = {i.get("purpose", "any") for i in icons}
    check("manifest lists 192+512 icons with a maskable",
          {"192x192", "512x512"} <= sizes and "maskable" in purposes,
          str(sizes) + " " + str(purposes))
    st, ct, _ = probe("/manifest.webmanifest")
    check("manifest MIME is manifest+json", st == 200 and "manifest+json" in ct,
          f"{st} {ct}")
    st, ct, csp = probe("/sw.js")
    check("sw.js served as JavaScript", st == 200 and "javascript" in ct,
          f"{st} {ct}")
    check("sw.js worker CSP allows same-origin fetches",
          "default-src 'self'" in csp, csp)
    sw = call("GET", "/sw.js")
    check("sw precaches shell + caches API data",
          isinstance(sw, str) and "al-shell-" in sw and "al-api-" in sw, str(type(sw)))
    check("sw intercepts fetch with offline fallback",
          isinstance(sw, str) and "addEventListener('fetch'" in sw and "networkFirst" in sw)
    st, ct, _ = probe("/tetris.js")
    check("tetris.js served as JavaScript", st == 200 and "javascript" in ct, f"{st} {ct}")
    tet = call("GET", "/tetris.js")
    check("tetris game is self-contained (no API calls)",
          isinstance(tet, str) and "/api/" not in tet and "fetch(" not in tet)
    check("index loads the hidden game", 'src="tetris.js' in html)
    check("service worker precaches the hidden game",
          isinstance(sw, str) and "tetris.js" in sw)
    check("hidden game keeps a local top five",
          isinstance(tet, str) and "cr_tetris_scores" in tet and "MAX_SCORES = 5" in tet)
    check("initials are stripped to letters and digits",
          isinstance(tet, str) and "replace(/[^A-Za-z0-9]/g, '')" in tet)
    check("high-score names are rendered as text, never markup",
          isinstance(tet, str) and "createElement('span')" in tet
          and "tt-hs-name'; nm.textContent" in tet)
    ui = call("GET", "/app.js")
    check("hidden game is never advertised in the UI chrome",
          isinstance(ui, str) and "tetris" not in ui.lower()
          and "tetris" not in call("GET", "/i18n.js").lower(),
          "app.js/i18n.js must not mention it")
    check("index links the manifest", 'rel="manifest"' in html)
    st, ct, _ = probe("/icon-512.png")
    check("512 icon served as PNG", st == 200 and "image/png" in ct, f"{st} {ct}")
    st, ct, _ = probe("/icon-192.png")
    check("192 icon served as PNG", st == 200 and "image/png" in ct, f"{st} {ct}")
    appjs = call("GET", "/app.js")
    check("app registers the service worker",
          isinstance(appjs, str) and "serviceWorker" in appjs and ".register(" in appjs)
    check("sign-out clears cached data", isinstance(appjs, str) and "clearApiCache" in appjs)

    print("theme + help assistant")
    css = call("GET", "/style.css")
    check("stylesheet supports an explicit dark theme",
          isinstance(css, str) and '[data-theme="dark"]' in css)
    check("stylesheet styles the theme picker and assistant",
          isinstance(css, str) and ".theme-opt" in css and ".help-bubble" in css)
    check("app wires the theme preference and picker",
          isinstance(appjs, str) and "initTheme" in appjs and "openThemePicker" in appjs)
    check("app ships the help assistant",
          isinstance(appjs, str) and "openHelp" in appjs and "/api/support" in appjs)
    check("assistant renders replies as text, never markup",
          isinstance(appjs, str) and "bub.textContent = text" in appjs)
    i18n = call("GET", "/i18n.js")
    check("i18n carries the new theme and help strings",
          isinstance(i18n, str) and "'theme.system'" in i18n and "'help.greeting'" in i18n)
    check("app names the failing model instead of a generic error",
          isinstance(appjs, str) and "model_not_found" in appjs and "help.modelMissing" in appjs)
    check("i18n fills the model name into the message",
          isinstance(i18n, str) and "'help.modelMissing'" in i18n and "{model}" in i18n)
    check("app ships the assistant diagnostics panel",
          isinstance(appjs, str) and "openDiagModal" in appjs
          and "/api/support/diagnostics" in appjs)
    check("i18n carries the diagnostics strings",
          isinstance(i18n, str) and "'diag.title'" in i18n and "'diag.menu'" in i18n)

    sup = call("POST", "/api/support",
               {"messages": [{"role": "user", "content": "How do I add a student?"}]})
    check("support answers from the built-in guide without a key",
          sup.get("configured") is True and sup.get("mode") == "builtin"
          and isinstance(sup.get("reply"), str) and len(sup["reply"]) > 40, str(sup))
    bad = call("POST", "/api/support", {}, expect=400)
    check("support rejects a missing message list", "error" in bad)
    nonuser = call("POST", "/api/support",
                   {"messages": [{"role": "assistant", "content": "hi"}]}, expect=400)
    check("support requires a user-turn last message", "error" in nonuser)

    print("status / setup")
    st = call("GET", "/api/status")
    check("status shape", st.get("setup_required") in (True, False), str(st))
    setup = call("POST", "/api/setup",
                 {"admin_code": ADMIN_CODE, "teacher_code": TEACHER_CODE,
                  "observer_code": OBSERVER_CODE})
    token = setup.get("token")
    check("setup returns admin token", bool(token))
    again = call("POST", "/api/setup", {"admin_code": "x1234", "teacher_code": "y1234"}, expect=403)
    check("second setup blocked", "error" in again)

    print("auth")
    bad = call("POST", "/api/login", {"role": "admin", "code": "wrong-code"}, expect=401)
    check("wrong admin code rejected", "error" in bad)
    adm = call("POST", "/api/login", {"role": "admin", "code": ADMIN_CODE})
    tch = call("POST", "/api/login", {"role": "teacher", "code": TEACHER_CODE})
    obs = call("POST", "/api/login", {"role": "observer", "code": OBSERVER_CODE})
    A, T, O = adm.get("token"), tch.get("token"), obs.get("token")
    check("admin login", bool(A))
    check("teacher login", bool(T))
    check("observer login", bool(O), str(obs))
    check("no token rejected", "error" in call("GET", "/api/students", expect=401))

    print("help assistant diagnostics")
    check("diagnostics needs a session",
          "error" in call("GET", "/api/support/diagnostics", expect=401))
    check("a teacher may not read diagnostics",
          "error" in call("GET", "/api/support/diagnostics", token=T, expect=403))
    check("an observer may not read diagnostics",
          "error" in call("GET", "/api/support/diagnostics", token=O, expect=403))
    diag = call("GET", "/api/support/diagnostics", token=A)
    check("an admin reads diagnostics", diag.get("enabled") is False, str(diag))
    check("diagnostics names the configured model",
          bool(diag.get("configured_model")), str(diag))
    check("diagnostics reports an unprobed provider as unknown, not unreachable",
          diag.get("provider_reachable") is None and diag.get("model_available") is None,
          str(diag))
    check("diagnostics never echoes the key",
          "api_key" not in json.dumps(diag).lower()
          and "bearer" not in json.dumps(diag).lower(), str(diag))

    print("roles & permissions")
    # teacher may now add students (new requirement); removal stays admin-only
    added = call("POST", "/api/students",
                 {"name": "Teacher Added", "grade": "6", "roll3": "999"}, token=T)
    check("teacher CAN add student", added.get("ok") is True, str(added))
    tid999 = [s["id"] for s in call("GET", "/api/students", token=T)["students"]
              if s["roll3"] == "999"]
    check("teacher's student listed", len(tid999) == 1, str(tid999))
    check("teacher cannot remove student",
          "error" in call("DELETE", f"/api/students?id={tid999[0]}", token=T, expect=403))
    call("DELETE", f"/api/students?id={tid999[0]}", token=A)
    left = [s for s in call("GET", "/api/students", token=A)["students"] if s["roll3"] == "999"]
    check("admin removed it again", len(left) == 0, str(left))
    check("observer can read students",
          isinstance(call("GET", "/api/students", token=O)["students"], list))
    check("observer cannot add student",
          "error" in call("POST", "/api/students",
                          {"name": "Nope Kid", "grade": "5", "roll3": "777"},
                          token=O, expect=403))
    check("observer cannot record attendance",
          "error" in call("POST", "/api/attendance",
                          {"date": "2026-10-03", "entries": []}, token=O, expect=403))
    check("teacher cannot record attendance", "error" in call(
        "POST", "/api/attendance", {"date": "2026-10-03", "entries": []}, token=T, expect=403))

    print("students")
    for name, grade, roll in [("Ayesha Khan", "5", "042"),
                              ("Rahul Verma", "5", "017"),
                              ("Zoya Sheikh", "6", "103"),
                              ("Mohit Rao", "5", "118")]:
        r = call("POST", "/api/students", {"name": name, "grade": grade, "roll3": roll}, token=A)
        check(f"add {name}", r.get("ok") is True)
    dup = call("POST", "/api/students", {"name": "Twin", "grade": "5", "roll3": "042"}, token=A, expect=400)
    check("duplicate grade+roll rejected", "error" in dup)
    badroll = call("POST", "/api/students", {"name": "Bad Roll", "grade": "5", "roll3": "42"}, token=A, expect=400)
    check("non-3-digit roll rejected", "error" in badroll)
    lst = call("GET", "/api/students", token=A)
    rolls = [(s["grade"], s["roll3"]) for s in lst["students"]]
    check("roster sorted by grade then roll",
          rolls == sorted(rolls, key=lambda g: (int(g[0]), g[1])), str(rolls))
    check("grades list", lst["grades"] == ["5", "6"], str(lst["grades"]))
    by_roll = {s["roll3"]: s["id"] for s in lst["students"]}
    check("4 students addressed by roll",
          set(by_roll) == {"017", "042", "118", "103"}, str(by_roll))

    print("activity log")
    feed = call("GET", "/api/activity", token=A).get("activity", [])
    check("admin sees activity feed", len(feed) > 0, str(len(feed)))
    seen = {(e["role"], e["action"]) for e in feed}
    check("teacher's add recorded", ("teacher", "student.add") in seen, str(seen))
    check("logins recorded", ("admin", "login") in seen, str(seen))
    check("teacher blocked from activity",
          "error" in call("GET", "/api/activity", token=T, expect=403))
    check("observer blocked from activity",
          "error" in call("GET", "/api/activity", token=O, expect=403))

    print("attendance")
    day = call("GET", "/api/attendance/day?date=2026-10-03", token=A)
    check("day returns 4 students", len(day["students"]) == 4, str(len(day["students"])))
    teacher_write = call("POST", "/api/attendance",
                         {"date": "2026-10-03", "entries": []}, token=T, expect=403)
    check("teacher cannot record attendance", "error" in teacher_write)
    entries = [{"student_id": by_roll["042"], "status": "present"},
               {"student_id": by_roll["017"], "status": "absent"},
               {"student_id": by_roll["118"], "status": "late"},
               {"student_id": by_roll["103"], "status": "present"}]
    r = call("POST", "/api/attendance", {"date": "2026-10-03", "entries": entries}, token=A)
    check("admin records attendance", r.get("ok") is True)
    r = call("POST", "/api/attendance", {"date": "2026-10-03", "entries": entries[:1]}, token=A)
    check("re-save upserts", r.get("ok") is True)
    summ = call("GET", "/api/attendance/month?month=2026-10", token=A)
    counts = {(x["grade"], x["roll3"]): x["marked"] for x in summ["rows"]}
    check("month summary marked counts", all(v == 1 for v in counts.values()), str(counts))
    p0 = [x for x in summ["rows"] if x["roll3"] == "042"][0]
    check("present percent 100", p0["percent"] == 100.0, str(p0["percent"]))
    bad = call("POST", "/api/attendance", {"date": "2026-13-40", "entries": []}, token=A, expect=400)
    check("bad date rejected", "error" in bad)

    print("tests + scores")
    t1 = call("POST", "/api/tests",
              {"name": "Unit Test 1", "month": "2026-10", "max_score": 25, "test_date": "2026-10-05"}, token=T)
    t2 = call("POST", "/api/tests",
              {"name": "Quiz 2", "month": "2026-10", "max_score": 20}, token=T)
    check("tests created", t1.get("ok") and t2.get("ok"))
    tests = call("GET", "/api/tests?month=2026-10", token=A)["tests"]
    check("two tests listed", len(tests) == 2, str(len(tests)))
    scores = [{"student_id": by_roll["042"], "score": 23},
              {"student_id": by_roll["017"], "score": 18},
              {"student_id": by_roll["118"], "score": 15},
              {"student_id": by_roll["103"], "score": ""}]
    r = call("POST", "/api/scores", {"test_id": t1["id"], "entries": scores}, token=T)
    check("scores saved", r.get("ok") is True)
    r = call("POST", "/api/scores",
             {"test_id": t1["id"], "entries": [{"student_id": by_roll["042"], "score": 99}]},
             token=T, expect=400)
    check("score over max rejected", "error" in r)
    call("POST", "/api/scores", {"test_id": t2["id"],
                                 "entries": [{"student_id": by_roll["042"], "score": 19},
                                             {"student_id": by_roll["017"], "score": 12},
                                             {"student_id": by_roll["118"], "score": 17}]}, token=T)
    sheet = call("GET", f"/api/scores?test_id={t1['id']}", token=A)
    check("score sheet has students", len(sheet["students"]) == 4)
    check("observer can read a score sheet",
          len(call("GET", f"/api/scores?test_id={t1['id']}", token=O)["students"]) == 4)
    check("observer cannot save scores",
          "error" in call("POST", "/api/scores",
                          {"test_id": t1["id"], "entries": []}, token=O, expect=403))
    blank = [s for s in sheet["students"] if s["roll3"] == "103"][0]
    check("blank score stored as null", blank["score"] is None, str(blank["score"]))

    print("report")
    rep = call("GET", "/api/report?month=2026-10", token=A)
    check("report has 4 rows", len(rep["rows"]) == 4, str(len(rep["rows"])))
    check("report has 2 test columns", len(rep["tests"]) == 2)
    rows = {r["roll3"]: r for r in rep["rows"]}
    top = rows["042"]
    check("totals summed across tests", top["obtained"] == 42 and top["max_total"] == 45,
          f"{top['obtained']}/{top['max_total']}")
    check("percent computed", abs(top["percent"] - 93.3) < 0.2, str(top["percent"]))
    check("grade letter A+", top["grade_letter"] == "A+", top["grade_letter"])
    check("top student ranked 1", top["rank"] == 1, str(top["rank"]))
    check("untested student has no rank", rows["103"]["rank"] is None, str(rows["103"]["rank"]))
    check("mid ranks correct", rows["118"]["rank"] == 2 and rows["017"]["rank"] == 3,
          f"118={rows['118']['rank']} 017={rows['017']['rank']}")
    check("attendance merged into report", rows["042"]["attendance"]["present"] == 1,
          str(rows["042"]["attendance"]))
    ranks = sorted(r["rank"] for r in rep["rows"] if r["rank"] is not None)
    check("ranks are 1..n", ranks == list(range(1, len(ranks) + 1)), str(ranks))

    tr = rep.get("trend") or []
    check("report trend spans 12 months", len(tr) == 12, str(len(tr)))
    check("trend window ends at requested month",
          bool(tr) and tr[-1]["month"] == "2026-10", str(tr[-1] if tr else None))
    check("trend starts 11 months back",
          bool(tr) and tr[0]["month"] == "2025-11", str(tr[0] if tr else None))
    check("trend percent = (present+late)/marked",
          bool(tr) and tr[-1]["percent"] == 75.0, str(tr[-1] if tr else None))
    check("trend marks months without data as null",
          all(x["percent"] is None for x in tr[:-1]), str([x["percent"] for x in tr]))
    tr5 = (call("GET", "/api/report?month=2026-10&grade=5", token=A).get("trend") or [])
    last5 = tr5[-1] if tr5 else None
    check("trend honours grade filter",
          last5 is not None and last5["percent"] == 66.7, str(last5))

    print("student detail")
    det = call("GET", f"/api/student?id={by_roll['042']}", token=A)
    check("detail profile", det["student"]["roll3"] == "042")
    check("detail attendance months", det["attendance_months"][0]["month"] == "2026-10")
    check("detail performance months", det["performance"][0]["obtained"] == 42,
          str(det["performance"]))
    check("detail lists tests", len(det["tests"]) == 2)
    missing = call("GET", "/api/student?id=99999", token=A, expect=400)
    check("missing student -> error", "error" in missing)

    print("csv export")
    csv_text = call("GET", "/api/export?month=2026-10", token=A)
    rows_csv = list(csv.reader(io.StringIO(csv_text)))
    check("csv header row", rows_csv[0][:3] == ["Grade", "Roll No", "Name"], str(rows_csv[0][:3]))
    check("csv has 4 data rows", len(rows_csv) == 5, str(len(rows_csv)))
    check("csv contains test columns", any("Unit Test 1" in h for h in rows_csv[0]))

    print("codes")
    r = call("POST", "/api/codes", {"teacher_code": "new-teacher-9"}, token=T, expect=403)
    check("teacher cannot change codes", "error" in r)
    call("POST", "/api/codes", {"teacher_code": "new-teacher-9"}, token=A)
    check("old teacher code dead", "error" in call("POST", "/api/login",
                                                   {"role": "teacher", "code": TEACHER_CODE}, expect=401))
    check("new teacher code works", bool(call("POST", "/api/login",
                                              {"role": "teacher", "code": "new-teacher-9"}).get("token")))

    print("cleanup")
    call("DELETE", f"/api/tests?id={t1['id']}", token=A)
    for sid in by_roll.values():
        call("DELETE", f"/api/students?id={sid}", token=A)
    left = call("GET", "/api/students", token=A)["students"]
    check("roster emptied after cleanup", len(left) == 0, str(len(left)))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(" -", f)
        sys.exit(1)
    print("ALL CHECKS PASSED")


main()
