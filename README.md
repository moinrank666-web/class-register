# Academic Ledger — Attendance & Monthly Performance

**Live app: [class-register-cudp.onrender.com](https://class-register-cudp.onrender.com/)**

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

All strings live in `static/i18n.js`: one dictionary per language, with `{placeholder}`
substitution. A missing key falls back to English, so a half-finished translation can
never break the UI. To add a language, add a dictionary, a `MONTHS` list and a row in
`LANGS`.

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

## Appearance: light, dark or system

A **🎨 Theme** pill sits on the sign-in screen and in the app header (also in the
menu and the command palette). Pick **Light**, **Dark**, or **System** to follow your
device — the choice is remembered per browser. Dark keeps the same layout with a
softer palette, and choosing Light keeps the page light even when the browser would
try to auto-darken it.

## Help desk (optional)

Every screen offers **💬 Help** — the header button, the menu, the command palette,
and a *Need a hand?* link under the sign-in form. It opens a small help desk that
answers questions about the register (signing in, students, attendance, scores,
reports, codes) and remembers the last few turns of the chat.

It answers with no setup at all: with no key configured the assistant uses a
**built-in guide** that matches your question against the app's real features and
answers offline — no provider, no key, no cost. Set the variables below to have it
answer with a language model instead, which is what you want for questions the
guide's fixed topics do not cover.

| Variable | Purpose |
|---|---|
| `SUPPORT_API_KEY` | Your provider key. Read server-side only — never sent to the browser. |
| `SUPPORT_API_URL` | Endpoint URL. Defaults to Groq (`https://api.groq.com/openai/v1/chat/completions`). |
| `SUPPORT_MODEL` | Model name. Defaults to `openai/gpt-oss-120b`. |
| `SUPPORT_FALLBACK_MODEL` | Second model to try if the provider does not know `SUPPORT_MODEL`. Defaults to `openai/gpt-oss-20b`; set it to an empty value to turn the retry off. |

Set these in the host's dashboard (on Render: *Environment*), never in the repo.

`GROQ_API_KEY` also works as a fallback for `SUPPORT_API_KEY`. The built-in guide
covers students, attendance, test scores and ranks, reports and CSV, codes and
sign-in, roles, Google sign-in, themes and languages, installing, the activity log
and data storage; anything else it answers with a short list of what it can help
with. Replies carry `"mode": "builtin"` so an operator can tell which path answered.
Model questions are capped at 20 per minute per IP address (the built-in guide is
local and free, so it is not capped). Only the text you type is sent
to the provider, alongside a short description of what the app does — never student
data or an access code.

### When the assistant stops answering

Providers retire models on their own schedule, and a retired model fails with an
error even when the key is perfectly good. That is what happened here:
**`llama-3.3-70b-versatile`, the original default, was shut down on 2026-08-16 and is
now enterprise-only.**

The app defends against this twice. First, a model the provider does not serve is
reported **by name** — the answer says which model to change, instead of blaming an
outage nothing in the deployment can fix. Second, rather than failing until someone
edits a variable, it retries the question once on `SUPPORT_FALLBACK_MODEL`; if that
works it keeps using it for later questions, and logs the switch to the standard
error stream. Only a model problem is retried — a 500 or a bad key is not, since a
second attempt would reach the same answer.

So if the help desk worked once and then stopped, the message now names the model.
Point `SUPPORT_MODEL` at one your provider currently serves and the retry stops being
needed. The provider's model list is always authoritative, e.g.
<https://console.groq.com/docs/models>. If you use a provider that is not Groq, set
`SUPPORT_FALLBACK_MODEL` to a model *it* serves, or to an empty value to disable the
retry.

Only `SUPPORT_API_URL`, `SUPPORT_MODEL` and `SUPPORT_FALLBACK_MODEL` change between
providers, so any
OpenAI-compatible service works. Providers that document a no-card free tier include
Groq (default), Google Gemini
(`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`) and
Mistral (`https://api.mistral.ai/v1/chat/completions`).

## Get found on Google

Everything crawlers need ships with the app: an indexable title/description with
**Academic Ledger** branding plus the generic `class register` search keywords,
`robots.txt` + `sitemap.xml` at the canonical address
[https://class-register-cudp.onrender.com/](https://class-register-cudp.onrender.com/), JSON-LD `WebApplication` and `WebSite`
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

**"Page is not indexed → Discovered - currently not indexed"?** That is not an
error: Google has fetched `robots.txt` and knows the URL, but a brand-new site with
no backlinks sits in the crawl queue for days to weeks. Confirm the sitemap shows
*Success* under *Sitemaps*, then URL Inspection → **Request indexing** on the home
page (repeat after each deploy). Crawl signals are all green — indexing is purely a
time-and-prominence game after this point.

**"Crawl allowed? No: blocked by robots.txt"?** `static/robots.txt` allows the whole
site — it carries `Allow: /` and no `Disallow` rule at all — so the file itself is not
the problem. Two things produce that message when the file is fine:

- **A fetch failure while the instance is asleep.** Render's free plan stops the
  service when idle, and the first request then takes 20 s or more. Google renders a
  failed `robots.txt` fetch with the same "blocked by robots.txt" wording, and it
  caches whatever it got. The keep-alive workflow (`.github/workflows/keep-awake.yml`)
  now pings the site every ten minutes *and* fails if `robots.txt` ever answers with a
  site-wide `Disallow`, so this cannot go unnoticed.
- **Inspecting the wrong host.** `www.class-register-cudp.onrender.com` fails its TLS
  handshake and can never be crawled. Inspect the bare address,
  `https://class-register-cudp.onrender.com/`, which is the canonical one.

You can check the served file yourself at any time:

```bash
curl -sS https://class-register-cudp.onrender.com/robots.txt
```

## Moving to your own domain (and making `www` work)

`www.class-register-cudp.onrender.com` can never work, and no change in this repo
fixes it. The certificate Render's edge presents is `CN=onrender.com` with
`SAN onrender.com, *.onrender.com` — a **single-label** wildcard. It covers the app's
own two-part name but not a third label, so the `www` host dies in the TLS handshake
with a fatal alert and every client, Google included, sees nothing. Search Console
reports that as *"Robots.txt unreachable"*: a connection failure, not a disallowed
file. A custom domain is the only real fix, and Render's free plan supports it.

**If you don't own one yet**, look for three things when you buy: a renewal price you
are happy with (first-year promotions are rarely the renewal price), free WHOIS
privacy, and DNS that can point a **root** record at a hostname — Render needs
ALIAS/ANAME or CNAME flattening at the apex, not just a plain A record. Checked in
2026, as a rough guide:

| Registrar | .com first year | .com renewal | Free WHOIS privacy | Apex alias |
|---|---|---|---|---|
| Porkbun | $11.08 | $11.08 | yes | `ALIAS` |
| Cloudflare Registrar | $10.46 | $10.46 | yes | CNAME flattening |
| Namecheap | $6.79 (new customers) | $18.48 | for eligible TLDs | `ALIAS` |

Prices move, so confirm the total and the renewal price at checkout, turn on
auto-renewal so the domain cannot lapse, and skip the email/hosting/security
add-ons. Do not buy an SSL certificate — Render issues and renews one for custom
domains. Any other registrar works too; Render documents a plain-`A` fallback for
providers without apex aliasing.

Until a custom domain exists, nothing below changes and nothing is broken: keep
using the apex `https://class-register-cudp.onrender.com/` and make sure that is the
address in Search Console. Only `www` is unreachable, and nothing links to it.

1. **Buy a domain**, then add it in Render: *service → Settings → Custom Domains →
   + Add Custom Domain*, entering the **apex** (`example.com`). Render automatically
   adds `www.example.com` and redirects it to the apex, which is exactly the shape
   you want. Certificates are issued and renewed for you, and plain HTTP is
   redirected to HTTPS.
2. **Point DNS at Render** at your registrar — and delete any AAAA records, because
   Render is IPv4-only and stray IPv6 records stall verification:

   | Hostname | Record | Value |
   |---|---|---|
   | `example.com` (`@`) | ANAME / ALIAS, or CNAME flattening | `class-register-cudp.onrender.com` |
   | `example.com` (`@`), if your provider offers none of those | `A` | `216.24.57.1` |
   | `www` | `CNAME` | `class-register-cudp.onrender.com` |

   On Cloudflare use a `CNAME` for both `@` and `www`, kept **DNS only** until Render
   reports the certificate as issued.
3. **Click *Verify*** on each domain in Render. A brief `502` while routing updates is
   normal.
4. **Move the canonical address in one pass.** It is written out verbatim in six
   files, so search-and-replace rather than hunting by hand:

   ```bash
   grep -rn "class-register-cudp.onrender.com" . | grep -v __pycache__
   ```

   | File | What has to change |
   |---|---|
   | `static/robots.txt` | the `Sitemap:` line and the comment above it |
   | `static/sitemap.xml` | the `<loc>` |
   | `static/index.html` | `rel="canonical"`, `og:url`, `og:image`, `twitter:image`, both JSON-LD blocks, and the `<noscript>` link |
   | `.github/workflows/keep-awake.yml` | the `SITE` variable the cron pings |
   | `test_api.py` | the two assertions that pin `robots.txt` and `sitemap.xml` to the address |
   | `README.md` | the links in this file |

5. **Leave the `onrender.com` address enabled** while DNS settles — it keeps serving
   alongside a custom domain, so nothing breaks mid-move. Once the canonical points
   at the new domain, Google consolidates the duplicates on its own.
6. **In Search Console, add a new URL-prefix property** for the new domain, verify it
   with its own HTML tag, submit the sitemap there, and request indexing. Keep the old
   property for a while so you can watch the move.

## Uptime monitoring

`/healthz` is a tiny public endpoint that answers `ok` from the process alone — no
database, no session lookup, no file read — so a monitor can tell "the app is up"
apart from "the database is unhappy". It is `no-store` and `noindex`, and it reports
the server identity `AttendanceRegister/1.0`, which is how a script proves the answer
came from this process rather than from a synthetic edge response for a sleeping one.

Two things watch the site:

- **`.github/workflows/keep-awake.yml`** runs every ten minutes and *is* the alert
  channel: GitHub emails you whenever a scheduled run fails. It fails when any of
  `/healthz`, `/`, `/robots.txt` or `/sitemap.xml` is not `200` after three tries,
  when the *first* attempt takes 8 s or more (a warm instance answers in well under a
  second, so that means it had gone to sleep and was booting again), when the reply
  carries no `AttendanceRegister/1.0` identity, or when `robots.txt` ever disallows
  the site.
- **UptimeRobot** (free) is the outside-the-repo monitor, and the only one that can
  reach you when GitHub itself is the thing that broke:

  1. Create a free account at [uptimerobot.com](https://uptimerobot.com).
  2. *Add New Monitor* → type **HTTP(s)** → URL
     `https://class-register-cudp.onrender.com/healthz` → interval **5 minutes** →
     alert contact = your email address.
  3. In that monitor's alert settings, keep **response-time** alerts enabled with the
     threshold at **8 seconds**, so a cold start warns you as loudly as an outage.

A five-minute check also keeps a free Render instance from idling into sleep in the
first place, which is the root cause of the stale-`robots.txt` incident above.

Check it by hand at any time:

```bash
curl -i https://class-register-cudp.onrender.com/healthz     # expect 200 ok
```

## Tests

```bash
# terminal 1 — test server on a throw-away database
ATTENDANCE_DB=./test_attendance.db ATTENDANCE_PORT=8766 python server.py

# terminal 2
python test_api.py http://127.0.0.1:8766
```

`test_api.py` covers setup, both roles and their permissions, student validation,
attendance upserts, score limits, report maths, student detail, CSV export, code
changes, the theme and help-desk wiring, and the support endpoint's validation and
unconfigured response.

## Files

```
server.py          HTTP server, auth, SQLite/Postgres storage, JSON API
test_api.py        end-to-end API checks
requirements.txt   psycopg (only used when DATABASE_URL is set)
static/index.html  page shell
static/style.css   Canva-style design system (light + dark palettes)
static/app.js      single-page front-end (vanilla JS, no build step)
attendance.db      your data (SQLite)
```
