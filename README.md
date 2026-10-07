# Academic Ledger — Attendance & Monthly Performance

A password-protected attendance register with monthly test performance, built as a
local web app. Local mode needs **no packages** — only the Python standard library
(`http.server` + `sqlite3`). Set `DATABASE_URL` and the same app runs on an external
Postgres so data survives cloud restarts (uses `psycopg` from `requirements.txt`).

## Run it

```bash
python server.py
```

Then open **http://127.0.0.1:8765** in your browser.

| What | Where |
|---|---|
| Requires | Python 3.8+ (you already have 3.11) |
| Data file | `attendance.db` (created next to `server.py`) |
| Change port / host | `ATTENDANCE_PORT=9000 ATTENDANCE_HOST=0.0.0.0 python server.py` |
| Reset everything | stop the server, delete `attendance.db`, start again |

## First-time setup

The first visit asks you to create **two different codes** (minimum 4 characters), plus
an optional third:

- **Admin code** — you. Adds/removes students, records daily attendance, can change codes,
  and sees the **🕓 Activity log** of everything the other codes did.
- **Teacher code** — the teacher. Adds students, enters monthly test scores, reads reports.
- **Observer code** *(optional)* — read-only third code: sees students, attendance, scores
  and reports, but can never add, edit or delete anything. Leave it blank to skip.

Codes are stored as salted PBKDF2 hashes, so they cannot be recovered — write them down.
Change them any time from **⚙️ Codes** in the header (admin only).

Every sign-in, added/removed student, saved score sheet, test change and code change is
recorded and shown to the admin on the **🕓 Activity** tab.

## Ten languages

The interface ships in **10 languages**: English · हिंदी (Hindi) · தமிழ் (Tamil) ·
Español · Français · Deutsch · Português · 中文 (Chinese) · العربية (Arabic) · 日本語 (Japanese).
Switch via **☰ Menu → 🌐 Language**, the **🌐** pill on the sign-in screen, the command
palette, or by typing `:lang ta` in the roster search bar — a picker lists all ten in
their native names. The choice is saved per browser and applies instantly to every
screen, month names and error messages. Arabic flips the whole layout to right-to-left.

All strings live in `static/i18n.js`: one dictionary per language with 256 keys and a
`{placeholder}` syntax. Missing keys fall back to English, so a partial translation can
never break the UI. To add a language, add one dictionary entry, one `MONTHS` list and
one row in `LANGS`.

## Command menu & hidden commands

All actions live in two menus instead of loose buttons:

- **☰ Menu** (top right) — add student, new test, export CSV, print, switch language,
  change access codes (admin), sign out.
- **Commands** pill in the sticky nav — or press **Ctrl K / ⌘K** — for a searchable
  command palette (pages, actions, preferences; ↑↓ moves, ↵ runs, esc closes).

Type **`:`** into the roster search bar to open the hidden command bar, then press ↵.
`:help` shows the same cheat sheet inside the app:

| Command | What it does |
|---|---|
| `:help` | Show the cheat sheet |
| `:nav students\|attendance\|scores\|report\|activity` | Jump to a page (`activity` is admin-only) |
| `:lang en\|hi\|ta` | Switch language |
| `:accent violet\|rose\|mint\|ocean\|sun` | Recolour the whole app (saved per browser) |
| `:sort name\|grade\|roll\|added` | Sort the roster (same as clicking a column header) |
| `:grade 5` / `:grade all` | Filter the roster by grade |
| `:add` / `:test` | Add a student / create a test (admin + teacher) |
| `:codes` | Open access codes (**admin only**) |
| `:export` / `:print` / `:clear` | Download CSV / print / reset search + filters |

Commands respect the signed-in role: a teacher or observer typing an admin command
only sees “Admin only”, and locked entries show a 🔒 in the suggestions.

## What each screen does

| Screen | What happens |
|---|---|
| 🎓 Students | Add **name, grade, and the last 3 digits of the roll number**. Stored in an orderly table sorted by grade, then roll (`5-042`) — click any column header to re-sort. Duplicate grade + roll pairs are rejected. |
| 🗓️ Attendance | Pick a date, tap Present / Absent / Late per student (or "All present"), save. Monthly summary shows present/absent/late counts and attendance %. |
| 📝 Test Scores | Create a test for a month (name, max marks, date), then enter each student's score. Live totals, % and letter grade appear as you type; blanks mean "not taken". |
| 📊 Reports | Every test as a column, with totals, %, letter grade, rank and attendance for the month. Click a row for the full student record. Export CSV or print. |

Reports compute: `Total = Σ marks`, `% = total / total max × 100`,
grade letters (A+ ≥ 90 … F < 40), competition ranking (ties share a rank),
attendance % = (present + late) ÷ marked days.

## Persist data in the cloud (survive Render restarts)

Without `DATABASE_URL`, everything lives in the local `attendance.db` file — on
Render's free tier that file is **wiped on every restart/redeploy**. Point the app
at a hosted Postgres and the data lives outside the instance instead:

1. **Render Dashboard → New + → Postgres** → choose the **Free** plan → Create.
2. Open the database → **Connections** → copy the **External Database URL**
   (it looks like `postgresql://…?sslmode=require`).
3. Your **Web Service → Environment** → add `DATABASE_URL` = that URL → Save,
   then **Deploy**. (`requirements.txt` installs `psycopg` automatically.)
4. First boot runs against an empty database, so do the first-time setup again
   (same two codes) and re-add your students once.

Rules of the dual-mode design:

| | Local mode | Cloud mode |
|---|---|---|
| Trigger | `DATABASE_URL` unset | `DATABASE_URL` set |
| Storage | `attendance.db` (SQLite, stdlib) | Postgres via `psycopg` |
| Extra deps | none | `pip install -r requirements.txt` |
| Same test suite | `python test_api.py …` | `DATABASE_URL=… python test_api.py …` |

Free Postgres instances sleep when idle: the first request after a quiet period
wakes them (a few seconds), after which everything is fast.

## Installable & offline (PWA)

The app ships a web app manifest and a service worker, so browsers offer
**Install as an app** (address-bar icon, or ⋮ → *Install page as app…*). Once
installed it opens in its own window under the Academic Ledger icon — no
browser chrome, just the register.

Offline behaviour:

- The shell (HTML, CSS, JS, fonts, icons, manifest) is precached on first
  visit, so the app opens even with no connection.
- Successful `GET /api/` responses are cached at runtime, so the last screens
  you looked at still render offline. Live data always wins when the server
  is reachable (network-first).
- Cached data is **cleared on sign-out**, so saved data never outlives a
  session. Marking attendance, saving scores and other changes need the
  server — offline they fail with a clear "You are offline" message.

## Get found on Google

Everything crawlers need ships with the app: an indexable title/description with
**Academic Ledger** branding plus the generic `class register` search keywords,
`robots.txt` + `sitemap.xml` at the canonical address
`https://class-register-cudp.onrender.com/`, JSON-LD `WebApplication` and `WebSite`
schema, and crawlable copy on the loading screen plus a `<noscript>` fallback.
Three steps on your side finish the job:

1. **Deploy the latest commit** on Render (Dashboard → *Manual Deploy* →
   *Deploy latest commit*) — production must serve the current build.
2. **Verify in Google Search Console**:
   - Open [search.google.com/search-console](https://search.google.com/search-console) → *Add property* →
     **URL prefix** → `https://class-register-cudp.onrender.com/` → Continue.
   - Pick verification method **HTML tag** and copy its `content` value.
   - Paste it into `static/index.html`, replacing `REPLACE_WITH_YOUR_GOOGLE_TOKEN`
     in the `<meta name="google-site-verification" …>` line → commit, push, redeploy
     → click *Verify*.
3. **Submit the sitemap**: Search Console → *Sitemaps* →
   `https://class-register-cudp.onrender.com/sitemap.xml` → *Submit*, then use
   URL Inspection → *Request indexing* on the home page.

After that, `site:class-register-cudp.onrender.com` lists what Google indexed, and
searching **Academic Ledger** (or pasting the address itself) finds the app.

## Tests

```bash
# terminal 1 — test server on a throw-away database
ATTENDANCE_DB=./test_attendance.db ATTENDANCE_PORT=8766 python server.py

# terminal 2
python test_api.py http://127.0.0.1:8766
```

`test_api.py` covers setup, both roles and their permissions, student validation,
attendance upserts, score limits, report maths, student detail, CSV export and code changes.

## Files

```
server.py          HTTP server, auth, SQLite/Postgres storage, JSON API
test_api.py        end-to-end API checks
requirements.txt   psycopg (only used when DATABASE_URL is set)
static/index.html  page shell
static/style.css   Canva-style design system (light + curated dark fallback)
static/app.js      single-page front-end (vanilla JS, no build step)
attendance.db      your data (SQLite)
```
