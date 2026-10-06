#!/usr/bin/env python3
"""
Attendance & Monthly Performance Register
=========================================
A zero-dependency local web server (Python standard library only).

Roles
-----
  * Admin  (the code YOU create) : manages the student roster, attendance, and codes.
  * Teacher (a second code)      : enters monthly test scores and reads reports.

Data lives in attendance.db next to this file.

Run:  python server.py          (then open http://127.0.0.1:8765)
"""

import csv
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("ATTENDANCE_DB", os.path.join(BASE_DIR, "attendance.db"))

# External persistence: when DATABASE_URL is set (e.g. Render Postgres / Neon),
# all data lives there and survives restarts & redeploys. Without it the app
# keeps using the local SQLite file exactly as before (zero dependencies).
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USE_PG = bool(DATABASE_URL)
LIKE_OP = "ILIKE" if USE_PG else "LIKE"

if USE_PG:
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        # Do not crash the whole service: run on SQLite (as the original
        # build did) and shout about it in the logs.
        print(
            "[warn] DATABASE_URL is set but psycopg is missing — falling back "
            "to local SQLite.\n"
            "       Run:  pip install \"psycopg[binary]\"   (or pip install -r requirements.txt)",
            file=sys.stderr,
        )
        USE_PG = False
        LIKE_OP = "LIKE"
STATIC_DIR = os.path.join(BASE_DIR, "static")
# Local runs stay loopback-only; on a cloud host (Render sets RENDER and PORT)
# we must listen on every interface, otherwise the platform's port scan finds
# nothing on 0.0.0.0 and the deploy times out.
_HOST_OVERRIDE = os.environ.get("ATTENDANCE_HOST", "").strip()
HOST = _HOST_OVERRIDE or (
    "0.0.0.0" if (os.environ.get("RENDER") or os.environ.get("PORT"))
    else "127.0.0.1"
)
def _resolve_port() -> int:
    """ATTENDANCE_PORT wins, then a valid $PORT (e.g. Render's), else 8765.
    Guards against junk values like PORT=0 which would bind a random port."""
    for key in ("ATTENDANCE_PORT", "PORT"):
        raw = os.environ.get(key)
        if raw and raw.isdigit() and 0 < int(raw) <= 65535:
            return int(raw)
    return 8765


PORT = _resolve_port()

SESSION_TTL_SECONDS = 8 * 60 * 60          # absolute lifetime: 8 hours
SESSION_IDLE_SECONDS = 2 * 60 * 60         # logged out after 2 h of inactivity
PBKDF2_ITERATIONS = 600_000                # OWASP-recommended PBKDF2-SHA256 work factor

# Brute-force protection for the code endpoints (in-memory, per client IP)
RATE_WINDOW_SECONDS = 60
RATE_MAX_FAILURES = 8
RATE_LOCKOUT_SECONDS = 600

HTML_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; "
            "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
API_CSP = "default-src 'none'; frame-ancestors 'none'"
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
DATE_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")
ROLL_RE = re.compile(r"^\d{3}$")

SESSIONS = {}
SESSIONS_LOCK = threading.Lock()
LOGIN_ATTEMPTS = {}          # "kind:ip" -> {start, fails, lock_until}
LOGIN_ATTEMPTS_LOCK = threading.Lock()

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
}


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    grade      TEXT NOT NULL,
    roll3      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (grade, roll3)
);
CREATE TABLE IF NOT EXISTS attendance (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('present','absent','late')),
    UNIQUE (student_id, date)
);
CREATE TABLE IF NOT EXISTS tests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    month      TEXT NOT NULL,
    max_score  REAL NOT NULL,
    test_date  TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id    INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    score      REAL NOT NULL,
    UNIQUE (test_id, student_id)
);
CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    role       TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_scores_test ON scores(test_id);
"""

SCHEMA_PG = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL,
    grade      TEXT NOT NULL,
    roll3      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (grade, roll3)
);
CREATE TABLE IF NOT EXISTS attendance (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('present','absent','late')),
    UNIQUE (student_id, date)
);
CREATE TABLE IF NOT EXISTS tests (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL,
    month      TEXT NOT NULL,
    max_score  DOUBLE PRECISION NOT NULL,
    test_date  TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scores (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    test_id    BIGINT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    score      DOUBLE PRECISION NOT NULL,
    UNIQUE (test_id, student_id)
);
CREATE TABLE IF NOT EXISTS activity (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role       TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_scores_test ON scores(test_id);
"""


class _PgConn:
    """sqlite3-compatible surface over a psycopg connection
    (? placeholders become %s; rows come back as plain dicts)."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=None):
        return self._conn.execute(sql.replace("?", "%s"), params if params else None)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()


@contextmanager
def db_conn():
    if USE_PG:
        raw = psycopg.connect(DATABASE_URL, connect_timeout=10,
                              row_factory=dict_row, autocommit=False)
        try:
            yield _PgConn(raw)
            raw.commit()
        except Exception:
            raw.rollback()
            raise
        finally:
            raw.close()
        return
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    if USE_PG:
        with db_conn() as c:
            for stmt in SCHEMA_PG.split(";"):
                stmt = stmt.strip()
                if stmt:
                    c.execute(stmt)
        return
    with db_conn() as c:
        c.executescript(SCHEMA)


def grade_num(col="grade"):
    """Numeric view of the grade column for ordering (non-numeric sorts as 0).
    Both dialects: SQLite CAST yields 0 for junk; PG CAST would raise, so use a
    regex-guarded expression there."""
    if USE_PG:
        return (f"(CASE WHEN {col} ~ '^[0-9]+' "
                f"THEN CAST(regexp_replace({col}, '\\D', '', 'g') AS INTEGER) ELSE 0 END)")
    return f"CAST({col} AS INTEGER)"


def insert_id(c, sql, params):
    """Run an INSERT and return the new row id on both backends."""
    if USE_PG:
        return c.execute(sql + " RETURNING id", params).fetchone()["id"]
    return c.execute(sql, params).lastrowid


def is_unique_violation(exc) -> bool:
    if USE_PG:
        return isinstance(exc, psycopg.errors.UniqueViolation)
    return isinstance(exc, sqlite3.IntegrityError)


def log_activity(c, role, action, detail=""):
    """Append one audit row; the admin reviews these on the Activity tab."""
    c.execute("INSERT INTO activity(role, action, detail, created_at) VALUES(?,?,?,?)",
              (role, action, detail, datetime.now().isoformat(timespec="seconds")))


# --------------------------------------------------------------------------
# Password codes
# --------------------------------------------------------------------------
def hash_code(code: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", code.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${dk.hex()}"


def verify_code(code: str, stored: str) -> bool:
    try:
        _algo, iterations, salt, digest = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", code.encode("utf-8"), bytes.fromhex(salt), int(iterations))
        return secrets.compare_digest(dk.hex(), digest)
    except Exception:
        return False


def needs_rehash(stored: str) -> bool:
    """True when a stored hash uses fewer iterations than the current policy."""
    try:
        return int(stored.split("$")[1]) < PBKDF2_ITERATIONS
    except Exception:
        return True


# --------------------------------------------------------------------------
# Brute-force protection (fixed window + lockout, per client IP)
# --------------------------------------------------------------------------
def rate_check(ip: str, kind: str) -> int:
    """Seconds the caller must still wait (0 = allowed to try)."""
    now = time.time()
    with LOGIN_ATTEMPTS_LOCK:
        # bound memory: drop expired entries when the table grows
        if len(LOGIN_ATTEMPTS) > 1024:
            for k, s in list(LOGIN_ATTEMPTS.items()):
                if s["lock_until"] <= now and now - s["start"] >= RATE_WINDOW_SECONDS:
                    LOGIN_ATTEMPTS.pop(k, None)
        st = LOGIN_ATTEMPTS.get(f"{kind}:{ip}")
        if not st:
            return 0
        if st["lock_until"] > now:
            return int(st["lock_until"] - now) + 1
        if now - st["start"] >= RATE_WINDOW_SECONDS:
            LOGIN_ATTEMPTS.pop(f"{kind}:{ip}", None)
        return 0


def rate_fail(ip: str, kind: str) -> None:
    now = time.time()
    with LOGIN_ATTEMPTS_LOCK:
        key = f"{kind}:{ip}"
        st = LOGIN_ATTEMPTS.get(key)
        if not st or now - st["start"] >= RATE_WINDOW_SECONDS:
            st = {"start": now, "fails": 0, "lock_until": 0}
            LOGIN_ATTEMPTS[key] = st
        st["fails"] += 1
        if st["fails"] >= RATE_MAX_FAILURES:
            st["lock_until"] = now + RATE_LOCKOUT_SECONDS
            st["start"] = now
            st["fails"] = 0


def rate_clear(ip: str, kind: str) -> None:
    with LOGIN_ATTEMPTS_LOCK:
        LOGIN_ATTEMPTS.pop(f"{kind}:{ip}", None)


def get_setting(conn, key):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def setup_required():
    with db_conn() as c:
        return get_setting(c, "admin_hash") is None


def create_session(role):
    token = secrets.token_urlsafe(32)
    now = time.time()
    with SESSIONS_LOCK:
        if len(SESSIONS) >= 256:  # hard cap so session memory cannot be exhausted
            oldest = min(SESSIONS, key=lambda t: SESSIONS[t]["last"])
            SESSIONS.pop(oldest, None)
        SESSIONS[token] = {"role": role, "exp": now + SESSION_TTL_SECONDS, "last": now}
    return token


def drop_session(token):
    with SESSIONS_LOCK:
        SESSIONS.pop(token, None)


def session_role(token):
    if not token:
        return None
    now = time.time()
    with SESSIONS_LOCK:
        info = SESSIONS.get(token)
        if not info:
            return None
        if info["exp"] < now or now - info["last"] > SESSION_IDLE_SECONDS:
            SESSIONS.pop(token, None)
            return None
        info["last"] = now
        return info["role"]


def drop_sessions_except(token):
    """Revoke every session except the caller's (used when codes change)."""
    with SESSIONS_LOCK:
        for t in list(SESSIONS):
            if t != token:
                SESSIONS.pop(t, None)


# --------------------------------------------------------------------------
# Validation helpers
# --------------------------------------------------------------------------
def text(value, field, min_len=1, max_len=80):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be text.")
    value = value.strip()
    if len(value) < min_len:
        raise ValueError(f"{field} must be at least {min_len} characters.")
    if len(value) > max_len:
        raise ValueError(f"{field} must be at most {max_len} characters.")
    return value


def month_of(value):
    value = text(value, "Month", 7, 7)
    if not MONTH_RE.match(value):
        raise ValueError("Month must be in YYYY-MM format.")
    return value


def date_of(value):
    value = text(value, "Date", 10, 10)
    if not DATE_RE.match(value):
        raise ValueError("Date must be in YYYY-MM-DD format.")
    datetime.strptime(value, "%Y-%m-%d")  # rejects impossible days
    return value


def letter_grade(pct):
    if pct is None:
        return "-"
    if pct >= 90:
        return "A+"
    if pct >= 80:
        return "A"
    if pct >= 70:
        return "B+"
    if pct >= 60:
        return "B"
    if pct >= 50:
        return "C"
    if pct >= 40:
        return "D"
    return "F"


def pct(obtained, maximum):
    if not maximum:
        return None
    return round(100.0 * obtained / maximum, 1)


# --------------------------------------------------------------------------
# Query builders
# --------------------------------------------------------------------------
def list_students(conn, grade=None, q=None):
    sql = "SELECT * FROM students"
    args = []
    where = []
    if grade:
        where.append("grade = ?")
        args.append(grade)
    if q:
        where.append(f"(name {LIKE_OP} ? OR roll3 {LIKE_OP} ? OR grade {LIKE_OP} ?)")
        args.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {grade_num()}, grade, roll3, name"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def attendance_summary(conn, month, grade=None):
    grade_cond = "s.grade = ?" if grade else "TRUE"
    args = [f"{month}-%"] + ([grade] if grade else [])
    rows = conn.execute(
        f"""
        SELECT s.id, s.name, s.grade, s.roll3,
               SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) AS present,
               SUM(CASE WHEN a.status='absent'  THEN 1 ELSE 0 END) AS absent,
               SUM(CASE WHEN a.status='late'    THEN 1 ELSE 0 END) AS late,
               COUNT(a.id) AS marked
        FROM students s
        LEFT JOIN attendance a ON a.student_id = s.id AND a.date LIKE ?
        WHERE {grade_cond}
        GROUP BY s.id
        ORDER BY {grade_num()}, s.grade, s.roll3, s.name
        """,
        tuple(args),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        on_time = d["present"] + d["late"]
        d["percent"] = round(100.0 * on_time / d["marked"], 1) if d["marked"] else None
        out.append(d)
    return out


def build_report(conn, month, grade=None):
    students = list_students(conn, grade=grade)
    tests = [dict(r) for r in conn.execute(
        "SELECT * FROM tests WHERE month = ? ORDER BY COALESCE(test_date, created_at), id",
        (month,)).fetchall()]
    test_ids = [t["id"] for t in tests]

    scores = {}
    if test_ids:
        marks = conn.execute(
            f"SELECT test_id, student_id, score FROM scores WHERE test_id IN ({','.join('?' * len(test_ids))})",
            test_ids).fetchall()
        scores = {(m["test_id"], m["student_id"]): m["score"] for m in marks}

    att = {row["id"]: row for row in attendance_summary(conn, month, grade=grade)}

    rows = []
    for s in students:
        marks = {}
        obtained = 0.0
        maximum = 0.0
        for t in tests:
            val = scores.get((t["id"], s["id"]))
            marks[t["id"]] = val
            if val is not None:
                obtained += val
                maximum += t["max_score"]
        p = pct(obtained, maximum) if maximum else None
        a = att.get(s["id"], {"present": 0, "absent": 0, "late": 0, "marked": 0, "percent": None})
        rows.append({
            "student_id": s["id"], "name": s["name"], "grade": s["grade"], "roll3": s["roll3"],
            "marks": marks, "obtained": round(obtained, 2), "max_total": round(maximum, 2),
            "percent": p, "grade_letter": letter_grade(p), "rank": None,
            "attendance": a,
        })

    ranked = sorted(rows, key=lambda r: (-(r["percent"] if r["percent"] is not None else -1),
                                         r["grade"], r["roll3"]))
    prev_key, prev_rank = object(), 0  # competition ranking: equal scores share a rank
    for i, r in enumerate(ranked, start=1):
        if r["percent"] is None:
            r["rank"] = None
            continue
        if r["percent"] != prev_key:
            prev_key, prev_rank = r["percent"], i
        r["rank"] = prev_rank

    scored = [r["percent"] for r in rows if r["percent"] is not None]
    class_stats = {
        "students": len(rows),
        "tested": len(scored),
        "average": round(sum(scored) / len(scored), 1) if scored else None,
        "highest": max(scored) if scored else None,
        "tests": len(tests),
    }
    return {"month": month, "grade": grade, "tests": tests, "rows": rows, "class": class_stats}


def student_detail(conn, student_id):
    s = conn.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    if not s:
        raise ValueError("Student not found.")
    s = dict(s)

    att_months = [dict(r) for r in conn.execute(
        """
        SELECT substr(date,1,7) AS month,
               SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present,
               SUM(CASE WHEN status='absent'  THEN 1 ELSE 0 END) AS absent,
               SUM(CASE WHEN status='late'    THEN 1 ELSE 0 END) AS late,
               COUNT(*) AS marked
        FROM attendance WHERE student_id = ?
        GROUP BY substr(date,1,7) ORDER BY month DESC
        """, (student_id,)).fetchall()]
    for m in att_months:
        on_time = m["present"] + m["late"]
        m["percent"] = round(100.0 * on_time / m["marked"], 1) if m["marked"] else None

    perf = [dict(r) for r in conn.execute(
        """
        SELECT t.month AS month, COUNT(*) AS tests,
               SUM(sc.score) AS obtained, SUM(t.max_score) AS maximum
        FROM tests t JOIN scores sc ON sc.test_id = t.id
        WHERE sc.student_id = ?
        GROUP BY t.month ORDER BY t.month DESC
        """, (student_id,)).fetchall()]
    for p in perf:
        p["percent"] = pct(p["obtained"], p["maximum"])
        p["grade_letter"] = letter_grade(p["percent"])

    recent = [dict(r) for r in conn.execute(
        "SELECT date, status FROM attendance WHERE student_id = ? ORDER BY date DESC LIMIT 14",
        (student_id,)).fetchall()]

    detail_tests = [dict(r) for r in conn.execute(
        """
        SELECT t.id, t.name, t.month, t.max_score, t.test_date, sc.score
        FROM tests t LEFT JOIN scores sc ON sc.test_id = t.id AND sc.student_id = ?
        ORDER BY t.month DESC, COALESCE(t.test_date, t.created_at), t.id
        """, (student_id,)).fetchall()]

    return {"student": s, "attendance_months": att_months, "performance": perf,
            "recent": recent, "tests": detail_tests}


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "AttendanceRegister/1.0"
    protocol_version = "HTTP/1.1"
    sys_version = ""            # do not advertise the Python version
    timeout = 60                # drop slow/idle connections (slowloris guard)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (TimeoutError, ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            # client went away (idle keep-alive close, tab closed, network drop)
            self.close_connection = True

    # ---------- plumbing ----------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def _send(self, body: bytes, content_type: str, status: int = 200, extra=None,
              cache: str = "no-store", csp: str = API_CSP, noindex: bool = False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Security-Policy", csp)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy",
                         "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
        self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if noindex:
            self.send_header("X-Robots-Tag", "noindex, nofollow")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if getattr(self, "_head_only", False):
            return          # HEAD: headers only, Content-Length already sent
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def send_json(self, data, status=200, extra=None):
        self._send(json.dumps(data).encode("utf-8"), "application/json; charset=utf-8",
                   status, extra=extra, noindex=True)

    def fail(self, message, status=400, extra=None):
        self.send_json({"error": message}, status, extra=extra)

    def client_ip(self):
        """Best-effort client identity for rate limiting (proxy-aware)."""
        cf = self.headers.get("CF-Connecting-IP")
        if cf:
            return cf.strip()
        xff = self.headers.get("X-Forwarded-For")
        if xff:
            return xff.split(",")[-1].strip()
        return self.client_address[0]

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ValueError("Content-Type must be application/json.")
        raw = self.rfile.read(length)
        if len(raw) > 2_000_000:
            raise ValueError("Request too large.")
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            raise ValueError("Invalid JSON body.")
        if not isinstance(data, dict):
            raise ValueError("JSON object expected.")
        return data

    def _token(self):
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            return header[7:].strip()
        return None

    def auth(self, require_role=None):
        """Returns role or sends an error response and returns None."""
        role = session_role(self._token())
        if not role:
            self.fail("Session expired or not signed in.", 401)
            return None
        if require_role == "admin" and role != "admin":
            self.fail("Admin access required.", 403)
            return None
        return role

    # ---------- verbs ----------
    def do_GET(self):
        self._handle("GET")

    def do_HEAD(self):
        # Render's health check / port probe uses HEAD; without this the
        # stdlib handler answers 501 and every deploy is marked failed.
        self._head_only = True
        try:
            self._handle("GET")
        finally:
            self._head_only = False

    def do_POST(self):
        self._handle("POST")

    def do_DELETE(self):
        self._handle("DELETE")

    def do_PUT(self):
        self._handle("PUT")

    def _handle(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            try:
                self.api(method, path, parse_qs(parsed.query))
            except ValueError as exc:
                self.fail(str(exc), 400)
            except Exception:
                traceback.print_exc()
                self.fail("Server error. See console for details.", 500)
        else:
            if method != "GET":
                self.fail("Method not allowed.", 405)
            self.serve_static(path)

    # ---------- static ----------
    def serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        full = os.path.realpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep):
            self.fail("Not found.", 404)
            return
        if not os.path.isfile(full):
            self.fail("Not found.", 404)
            return
        ext = os.path.splitext(full)[1].lower()
        # Cache static assets so repeat visits skip re-downloads; keep the
        # HTML shell and all API responses fresh.
        if ext == ".woff2":
            cache = "public, max-age=604800"
        elif ext in (".css", ".js"):
            cache = "public, max-age=300"
        else:
            cache = "no-store"
        if ext == ".html":
            csp = HTML_CSP
        elif ext in (".png", ".jpg", ".ico", ".svg", ".woff2"):
            # image responses may be wrapped in a browser image-viewer
            # document, which styles itself with a small inline style
            csp = "default-src 'none'; style-src 'unsafe-inline'"
        else:
            csp = "default-src 'none'"
        with open(full, "rb") as fh:
            self._send(fh.read(), MIME.get(ext, "application/octet-stream"),
                       cache=cache, csp=csp)

    # ---------- API ----------
    def api(self, method, path, qs):
        def q(name, default=None):
            v = qs.get(name, [default])
            return v[0] if v else default

        # --- public ---
        if method == "GET" and path == "/api/status":
            self.send_json({"setup_required": setup_required(), "app": "Attendance Register"})
            return

        if method == "POST" and path == "/api/setup":
            ip = self.client_ip()
            wait = rate_check(ip, "setup")
            if wait:
                self.fail(f"Too many attempts. Try again in {wait} seconds.", 429,
                          extra={"Retry-After": str(wait)})
                return
            rate_fail(ip, "setup")
            if not setup_required():
                self.fail("Setup already completed.", 403)
                return
            b = self.body()
            admin = text(b.get("admin_code"), "Admin code", 4, 64)
            teacher = text(b.get("teacher_code"), "Teacher code", 4, 64)
            observer = b.get("observer_code") or ""
            if observer:
                observer = text(observer, "Observer code", 4, 64)
            if admin == teacher:
                raise ValueError("The two codes must be different.")
            if observer and observer in (admin, teacher):
                raise ValueError("All codes must be different.")
            with db_conn() as c:
                c.execute("INSERT INTO settings(key, value) VALUES(?,?)", ("admin_hash", hash_code(admin)))
                c.execute("INSERT INTO settings(key, value) VALUES(?,?)", ("teacher_hash", hash_code(teacher)))
                if observer:
                    c.execute("INSERT INTO settings(key, value) VALUES(?,?)",
                              ("observer_hash", hash_code(observer)))
                log_activity(c, "admin", "setup", "register created")
            rate_clear(ip, "setup")
            self.send_json({"ok": True, "token": create_session("admin"), "role": "admin"})
            return

        if method == "POST" and path == "/api/login":
            ip = self.client_ip()
            wait = rate_check(ip, "login")
            if wait:
                self.fail(f"Too many attempts. Try again in {wait} seconds.", 429,
                          extra={"Retry-After": str(wait)})
                return
            rate_fail(ip, "login")
            b = self.body()
            role = b.get("role")
            if role not in ("admin", "teacher", "observer"):
                raise ValueError("Choose admin, teacher or observer.")
            code = text(b.get("code"), "Code", 1, 64)
            key = {"admin": "admin_hash", "teacher": "teacher_hash",
                   "observer": "observer_hash"}[role]
            with db_conn() as c:
                stored = get_setting(c, key)
            if not stored or not verify_code(code, stored):
                time.sleep(0.4)
                self.fail("Incorrect code.", 401)
                return
            if needs_rehash(stored):
                # transparently upgrade legacy hashes to the current work factor
                with db_conn() as c:
                    c.execute("UPDATE settings SET value = ? WHERE key = ?", (hash_code(code), key))
            rate_clear(ip, "login")
            with db_conn() as c:
                log_activity(c, role, "login", "")
            self.send_json({"ok": True, "role": role, "token": create_session(role)})
            return

        if method == "POST" and path == "/api/logout":
            drop_session(self._token())
            self.send_json({"ok": True})
            return

        if method == "GET" and path == "/api/me":
            role = self.auth()
            if role:
                self.send_json({"role": role})
            return

        # --- everything below needs a session ---
        role = self.auth()
        if not role:
            return
        is_admin = role == "admin"
        if role == "observer" and method in ("POST", "DELETE", "PUT"):
            self.fail("Observer access is read-only.", 403)
            return

        if path == "/api/activity" and method == "GET":
            if not is_admin:
                self.fail("Admin access required.", 403)
                return
            with db_conn() as c:
                rows = [dict(r) for r in c.execute(
                    "SELECT role, action, detail, created_at FROM activity "
                    "ORDER BY id DESC LIMIT 150")]
            self.send_json({"activity": rows})
            return

        # codes
        if method == "POST" and path == "/api/codes":
            if not is_admin:
                self.fail("Admin access required.", 403)
                return
            b = self.body()
            updates = {}
            if b.get("admin_code"):
                updates["admin_hash"] = hash_code(text(b["admin_code"], "Admin code", 4, 64))
            if b.get("teacher_code"):
                updates["teacher_hash"] = hash_code(text(b["teacher_code"], "Teacher code", 4, 64))
            if b.get("observer_code"):
                updates["observer_hash"] = hash_code(text(b["observer_code"], "Observer code", 4, 64))
            if not updates:
                raise ValueError("Provide a new admin code, a new teacher code, a new observer code, or a combination.")
            with db_conn() as c:
                for k, v in updates.items():
                    c.execute("INSERT INTO settings(key, value) VALUES(?,?) "
                              "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, v))
                log_activity(c, role, "codes.change",
                             ", ".join(k.replace("_hash", "") for k in updates))
            drop_sessions_except(self._token())  # old credentials -> all other sessions die
            self.send_json({"ok": True})
            return

        # students
        if path == "/api/students":
            if method == "GET":
                with db_conn() as c:
                    students = list_students(c, grade=q("grade"), q=q("q"))
                    grades = [r["grade"] for r in c.execute(
                        f"SELECT grade FROM (SELECT DISTINCT grade FROM students) AS g "
                        f"ORDER BY {grade_num('g.grade')}, g.grade")]
                self.send_json({"students": students, "grades": grades})
                return
            if method == "POST":
                # admin and teacher may both add students; observer is blocked centrally
                b = self.body()
                name = text(b.get("name"), "Name", 2, 60)
                grade = text(b.get("grade"), "Grade", 1, 30)
                roll3 = text(b.get("roll3"), "Roll number", 1, 5)
                if not ROLL_RE.match(roll3):
                    raise ValueError("Roll number must be exactly the last 3 digits (000-999).")
                try:
                    with db_conn() as c:
                        student_id = insert_id(
                            c, "INSERT INTO students(name, grade, roll3, created_at) VALUES(?,?,?,?)",
                            (name, grade, roll3, datetime.now().isoformat(timespec="seconds")))
                        log_activity(c, role, "student.add", f"{name} · {grade}-{roll3}")
                except Exception as e:
                    if not is_unique_violation(e):
                        raise
                    raise ValueError(f"Grade {grade} already has a student with roll {roll3}.")
                self.send_json({"ok": True, "id": student_id})
                return
            if method == "DELETE":
                if not is_admin:
                    self.fail("Only the admin can remove students.", 403)
                    return
                sid = int(q("id", "0") or 0)
                with db_conn() as c:
                    row = c.execute("SELECT name, grade, roll3 FROM students WHERE id = ?", (sid,)).fetchone()
                    if not row:
                        raise ValueError("Student not found.")
                    c.execute("DELETE FROM students WHERE id = ?", (sid,))
                    log_activity(c, role, "student.delete",
                                 f"{row['name']} · {row['grade']}-{row['roll3']}")
                self.send_json({"ok": True})
                return

        # attendance
        if path == "/api/attendance/day" and method == "GET":
            d = date_of(q("date"))
            grade = q("grade")
            with db_conn() as c:
                students = list_students(c, grade=grade)
                marked = {r["student_id"]: r["status"] for r in c.execute(
                    "SELECT student_id, status FROM attendance WHERE date = ?", (d,))}
            for s in students:
                s["status"] = marked.get(s["id"])
            self.send_json({"date": d, "students": students})
            return

        if path == "/api/attendance/month" and method == "GET":
            m = month_of(q("month"))
            with db_conn() as c:
                rows = attendance_summary(c, m, grade=q("grade"))
            self.send_json({"month": m, "rows": rows})
            return

        if path == "/api/attendance" and method == "POST":
            if not is_admin:
                self.fail("Only the admin can record attendance.", 403)
                return
            b = self.body()
            d = date_of(b.get("date"))
            entries = b.get("entries")
            if not isinstance(entries, list):
                raise ValueError("entries must be a list.")
            valid = {"present", "absent", "late", None}
            with db_conn() as c:
                for e in entries:
                    status = e.get("status")
                    if status not in valid:
                        raise ValueError("Status must be present, absent, late or null.")
                    sid = int(e.get("student_id") or 0)
                    if status is None:
                        c.execute("DELETE FROM attendance WHERE student_id = ? AND date = ?", (sid, d))
                    else:
                        c.execute(
                            "INSERT INTO attendance(student_id, date, status) VALUES(?,?,?) "
                            "ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status",
                            (sid, d, status))
                log_activity(c, role, "attendance.save", d)
            self.send_json({"ok": True, "date": d})
            return

        # tests & scores (admin or teacher)
        if path == "/api/tests":
            if method == "GET":
                m = month_of(q("month"))
                with db_conn() as c:
                    tests = [dict(r) for r in c.execute(
                        "SELECT * FROM tests WHERE month = ? ORDER BY COALESCE(test_date, created_at), id",
                        (m,))]
                self.send_json({"month": m, "tests": tests})
                return
            if method == "POST":
                b = self.body()
                name = text(b.get("name"), "Test name", 2, 60)
                m = month_of(b.get("month"))
                try:
                    max_score = float(b.get("max_score"))
                except (TypeError, ValueError):
                    raise ValueError("Maximum score must be a number.")
                if not 1 <= max_score <= 1000:
                    raise ValueError("Maximum score must be between 1 and 1000.")
                test_date = b.get("test_date") or None
                if test_date:
                    test_date = date_of(test_date)
                with db_conn() as c:
                    tid = insert_id(
                        c, "INSERT INTO tests(name, month, max_score, test_date, created_at) VALUES(?,?,?,?,?)",
                        (name, m, max_score, test_date, datetime.now().isoformat(timespec="seconds")))
                    log_activity(c, role, "test.create", name)
                self.send_json({"ok": True, "id": tid})
                return
            if method == "DELETE":
                if not is_admin:
                    self.fail("Only the admin can delete tests.", 403)
                    return
                tid = int(q("id", "0") or 0)
                with db_conn() as c:
                    row = c.execute("SELECT name FROM tests WHERE id = ?", (tid,)).fetchone()
                    if not row:
                        raise ValueError("Test not found.")
                    c.execute("DELETE FROM tests WHERE id = ?", (tid,))
                    log_activity(c, role, "test.delete", row["name"])
                self.send_json({"ok": True})
                return

        if path == "/api/scores":
            if method == "GET":
                tid = int(q("test_id", "0") or 0)
                with db_conn() as c:
                    t = c.execute("SELECT * FROM tests WHERE id = ?", (tid,)).fetchone()
                    if not t:
                        raise ValueError("Test not found.")
                    students = list_students(c, grade=q("grade"))
                    marks = {r["student_id"]: r["score"] for r in c.execute(
                        "SELECT student_id, score FROM scores WHERE test_id = ?", (tid,))}
                for s in students:
                    s["score"] = marks.get(s["id"])
                self.send_json({"test": dict(t), "students": students})
                return
            if method == "POST":
                b = self.body()
                tid = int(b.get("test_id") or 0)
                entries = b.get("entries")
                if not isinstance(entries, list):
                    raise ValueError("entries must be a list.")
                with db_conn() as c:
                    t = c.execute("SELECT * FROM tests WHERE id = ?", (tid,)).fetchone()
                    if not t:
                        raise ValueError("Test not found.")
                    ceiling = float(t["max_score"])
                    for e in entries:
                        raw = e.get("score")
                        sid = int(e.get("student_id") or 0)
                        if raw in (None, ""):
                            c.execute("DELETE FROM scores WHERE test_id = ? AND student_id = ?", (tid, sid))
                            continue
                        try:
                            val = float(raw)
                        except (TypeError, ValueError):
                            raise ValueError("Scores must be numbers.")
                        if val < 0 or val > ceiling:
                            raise ValueError(f"Scores must be between 0 and {ceiling:g}.")
                        c.execute(
                            "INSERT INTO scores(test_id, student_id, score) VALUES(?,?,?) "
                            "ON CONFLICT(test_id, student_id) DO UPDATE SET score = excluded.score",
                            (tid, sid, val))
                    log_activity(c, role, "scores.save", t["name"])
                self.send_json({"ok": True})
                return

        # reports
        if path == "/api/report" and method == "GET":
            m = month_of(q("month"))
            with db_conn() as c:
                report = build_report(c, m, grade=q("grade"))
            self.send_json(report)
            return

        if path == "/api/student" and method == "GET":
            sid = int(q("id", "0") or 0)
            with db_conn() as c:
                data = student_detail(c, sid)
            self.send_json(data)
            return

        if path == "/api/export" and method == "GET":
            m = month_of(q("month"))
            grade = q("grade")
            with db_conn() as c:
                report = build_report(c, m, grade=grade)
            buf = io.StringIO()
            writer = csv.writer(buf)
            header = ["Grade", "Roll No", "Name"]
            header += [f"{t['name']} (/{t['max_score']:g})" for t in report["tests"]]
            header += ["Total", "Max", "%", "Grade", "Rank",
                       "Days Present", "Days Absent", "Days Late", "Attendance %"]
            writer.writerow(header)
            for r in report["rows"]:
                a = r["attendance"]
                row = [r["grade"], r["roll3"], r["name"]]
                row += [("" if r["marks"][t["id"]] is None else r["marks"][t["id"]]) for t in report["tests"]]
                row += [r["obtained"], r["max_total"],
                        "" if r["percent"] is None else r["percent"],
                        r["grade_letter"], "" if r["rank"] is None else r["rank"],
                        a.get("present") or 0, a.get("absent") or 0, a.get("late") or 0,
                        "" if a.get("percent") is None else a["percent"]]
                writer.writerow(row)
            data = buf.getvalue().encode("utf-8-sig")
            self._send(data, "text/csv; charset=utf-8", 200, {
                "Content-Disposition": f'attachment; filename="report_{m}.csv"'})
            return

        self.fail("Unknown endpoint.", 404)


# --------------------------------------------------------------------------
def _pg_reachable() -> bool:
    """Probe Postgres at startup (retries a few times, e.g. while it wakes up).
    Returns False so the caller can fall back instead of crash-looping."""
    if not USE_PG:
        return True
    last = None
    for attempt in range(1, 4):
        try:
            with psycopg.connect(DATABASE_URL, connect_timeout=6) as probe:
                probe.execute("SELECT 1")
            return True
        except Exception as exc:                     # noqa: BLE001 — report any failure
            last = exc
            print(f"[warn] Postgres unreachable (attempt {attempt}/3): {exc}",
                  file=sys.stderr, flush=True)
            if attempt < 3:
                time.sleep(2)
    print(f"[warn] DATABASE_URL is set but unreachable: {last}",
          file=sys.stderr, flush=True)
    return False


def main():
    global USE_PG, LIKE_OP
    if USE_PG and not _pg_reachable():
        USE_PG = False
        LIKE_OP = "LIKE"
        print("[warn] Falling back to local SQLite — data will NOT survive "
              "restarts/redeploys until Postgres is reachable.",
              file=sys.stderr, flush=True)
    init_db()
    try:
        os.chmod(DB_PATH, 0o600)   # best-effort: owner-only access to the data file
    except OSError:
        pass
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print("=" * 62)
    print("  Attendance & Monthly Performance Register")
    print(f"  Open  http://{HOST}:{PORT}   in your browser")
    print(f"  Data  {DB_PATH}")
    print("  Press Ctrl+C to stop.")
    print("=" * 62)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
