# Security

How the Parcel Viewer is protected, what is deliberately public, and what is still open.
Written for reviewers and whoever operates the deployment. Status as of 2026-09-26; the
open items are tracked in `docs/READINESS-CHECKLIST.md`.

## Reporting a vulnerability

Email **gis@vanburencountymi.gov** with "Security" in the subject. Please don't open a
public issue: this repository is public. (GitHub private vulnerability reporting will be
the preferred channel once an admin turns it on; readiness checklist B3.)

---

## 1. What we protect, and from whom

| Asset | Why it matters |
|---|---|
| **The Anthropic API key** (Map Buddy) | Anyone holding it can spend the county's money. |
| **Database credentials** (read role, Martin's role, the config writer role) | Direct access to the parcel database and the admin config store. |
| **The admin token** (`PV_ADMIN_TOKEN`) | Lets the holder change the published viewer configuration. |
| **The shared database's capacity** (db-dice, 25 connections) | Other county services share it; the viewer mustn't be able to starve them. |
| **Owner names and mailing addresses** | Public tax-roll records, but bulk scraping of them is still a harm (see 5). |
| **Visitors** | Script injection through data we render (owner names, addresses, config). |

**Threats we design against:** anonymous abuse of public endpoints (scraping, floods,
running up AI spend); injection through parcel data, search text, drawn shapes and
config; server-side request forgery through the map-image proxy; leaked secrets (in git,
in logs, in the wrong container); and mistakes at deploy time (a dev setting reaching
production).

**Out of scope for now:** authenticated users (the viewer has none; access control is
decision B1, below) and write paths to parcel data (the viewer is read-only; edits happen
in Parcel Studio).

## 2. What is public

The viewer is a public read-only map by design. **Maria's guidance (2026-09-25) is that
the API should not be public; the approach is decision B1, still open.** Until then:

| Surface | Who can reach it | Protection |
|---|---|---|
| Viewer pages (`/demo/`), static JS/CSS | Anyone | Security headers, CSP (report-only), no-store caching |
| Parcel API read routes (`/api/search`, `/api/parcel/…`, `/api/parcels`, `/api/cohort`, …) | Anyone | Rate limits (nginx + app), input validation, statement timeout |
| Vector tiles (`/tiles/`) | Anyone | nginx rate limit; read-only DB role |
| Aerial imagery (`/aerial/`) | Anyone | nginx rate limit; tile paths only; cached |
| `/api/wms-proxy` (federal flood / wetland / soil maps) | Anyone | HTTPS allowlist, no redirects, image types only, 5 MB cap, rate limit |
| `/api/report-error`, `/api/client-errors` | Anyone | Per-IP and global rate limits, size limits |
| Map Buddy (Cloud Run) | Anyone who knows the URL | CORS allowlist, per-IP rate limits, AI quota, request-size caps |
| Admin console page (`/admin/`) | Anyone | Page is public; **every write and layer discovery needs the admin token** |
| API docs (`/docs`, `/openapi.json`) | Nobody in production | Off unless `PV_API_DOCS=1` / `MAP_BUDDY_API_DOCS=1` (dev only) |

**Never served:** dotfiles (`.env`, `.git`), Map Buddy's backend source and deploy
script, `*.md` files, engine tests. `infra/smoke-test.sh` checks each of these returns 404.

## 3. Secrets: where they live and who sees them

| Secret | Production home | Seen by |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret Manager `MAP_BUDDY_ANTHROPIC_API_KEY`, mounted into Cloud Run by `map-buddy/deploy.sh` | Map Buddy only |
| `PV_DATABASE_URL` (read role) | The VM's `.env` (not in git) | `api` only |
| `MARTIN_DATABASE_URL` (`martin_ro`, SELECT-only) | The VM's `.env` | `martin` only |
| `PV_WRITER_DATABASE_URL` (`pv_writer`, `config` schema only) | The VM's `.env` / Secret Manager | `api` only |
| `PV_ADMIN_TOKEN` | The VM's `.env` | `api`; admins type it into their own browser session |
| `PV_SMTP_PASSWORD` | The VM's `.env` | `api` only |
| `SENTRY_DSN` | Secret Manager `dice-sentry-dsn` (to be created with the Sentry project) | `api`, Map Buddy |
| Google Maps **Embed** key (`integrations.googleMapsEmbedKey`) | County config | Public by design: browser keys are visible; it must be **HTTP-referrer-restricted** in the Google console |

**How that's enforced:**
- **Least privilege per container.** Each compose service lists only the settings it reads
  (`infra/docker-compose.prod.yml`); nothing uses a shared `env_file`. The API never sees
  the Anthropic key; Martin sees only its own login.
- **Least privilege per database role.** Read paths use read-only roles. The config writer
  role can touch only the `config` schema (`backend/migrations/0001_config_store.sql`).
- **Nothing secret in git.** `gitleaks` runs on every commit (pre-commit) and in CI; the
  full history scan is clean. `.gitignore` covers `.env.*`, keys and service-account files.
- **Nothing secret in logs.** Logs never contain query strings (owner-name searches) or
  request bodies; Sentry scrubs personal data (ADR 0001).
- **The admin token** is compared in constant time, is never stored by the admin console
  (it lives only in the page's memory: `window.PV_ADMIN_TOKEN`), and is checked **before**
  any database work, so an unauthenticated request can't even probe the store.

Rotating any of these: `docs/RUNBOOK.md` → "Rotating secrets".

## 4. Controls

**Abuse and cost**
- **nginx rate limits per client IP:** `/api/` 20 req/s (burst 60); search, parcels and
  cohort 5 req/s (burst 30); tiles and aerial 60 req/s (burst 300). The app adds its own
  limits (slowapi) on the email, error-beacon and map-proxy routes. Excess → 429.
- **Database protection:** a 10 s statement timeout on every query, bounded connection
  pools (API 10 per worker, Martin 8), and fast failure (503 in about 10 s) when the
  database is unreachable instead of piling up requests.
- **AI spend:** a per-tenant quota (200 calls per 24 h in production), result caching,
  prompt caching, per-route rate limits and request-size caps (64 KB body, 2,000-character
  message). ⚠ The quota counts **per Cloud Run instance** until a shared store exists
  (DIC-1862), so it isn't a hard ceiling. **The backstop is a monthly spend limit in the
  Anthropic Console** (set before going public).

**Input handling**
- Every query parameter and body is validated (FastAPI / Pydantic). Coordinates, drawn
  polygons, buffer sizes (≤ 5 miles), search length (≤ 100 chars, ≤ 8 terms) and ids are
  checked before they reach PostGIS; bad input gets a 400/422, never a 500.
- All SQL is parameterized. Attribute ids are bound as text.
- `/api/wms-proxy` fetches only from an allowlist of HTTPS hosts, refuses redirects,
  relays only image content types, caps size at 5 MB and never reflects upstream bodies.

**The browser**
- Everything rendered from data (owner names, addresses, config values, search results,
  AI text) is escaped before it reaches `innerHTML`; `engine/test/*escape*` tests load the
  real modules with hostile values.
- CSV export neutralizes spreadsheet formulas.
- **Headers:** `X-Content-Type-Options: nosniff` everywhere; `Referrer-Policy`,
  `X-Frame-Options: SAMEORIGIN` and a Content-Security-Policy on the pages.
- **CSP is report-only for now.** It allows `'unsafe-inline'` because `demo/index.html` has
  inline scripts, and three CDNs with Subresource Integrity on pinned libraries. Plan: move
  the inline scripts out, run a clean report period with testers, then enforce.
- **HSTS** is added where TLS terminates (nginx on the VM with Certbot; Drake to confirm).

**The AI boundary**
- Facts come from the database and deterministic code, never from the model. The model
  only narrates facts it is given, and its tools can only drive the map (the browser runs
  only commands in a fixed table, `_CMDS` in `map-buddy/js/map-buddy.js`) or read the same
  public API everyone can. It has no write access and
  no credentials. See `ARCHITECTURE.md` → "The AI boundary".
- **What reaches Anthropic:** the user's chat text and the parcel facts in play (PIN,
  owner name, address, acreage, values, class, flood/wetland/soil results), all from the
  public tax roll. No credentials, no admin data. The data-exposure question below covers
  whether that's acceptable for owner names.

**Supply chain and code**
- Python dependencies are exact-pinned; Dependabot proposes updates weekly (grouped).
- CodeQL scans every PR and weekly; the first full scan's 36 findings are all fixed.
- Containers run as a non-root user with health checks.
- Releases are tagged from `main` only; images are built from a clean tree and tagged
  with the commit (`map-buddy/deploy.sh` refuses a dirty tree).

## 5. Open decisions and known gaps

| Item | Status | Tracking |
|---|---|---|
| **Access control for the API and site** (token-based, per Maria). Options: per-tester credentials in nginx, or a small token service | **Decision pending (Maria)** | B1 / DIC-1863 |
| **Data exposure.** Owner names, mailing addresses and owner-name search are public records, but bulk access to them is a scraping risk; B1 would put the testing site behind tester access | **Decision pending (county)** | Q10 / DIC-1863 |
| Admin console auth: a shared interim token today; real per-user auth later | Interim | DIC-463 |
| AI quota is per instance, not shared | Anthropic spend limit is the backstop | DIC-1862 |
| `/judge` and `/autoconfigure` (developer tools) are reachable on Map Buddy | Rate-limited and within the quota; to be locked down | DIC-1854 |
| CSP report-only; `'unsafe-inline'` | Planned | readiness checklist 8 |
| GitHub secret scanning, push protection, Dependabot security alerts, Semgrep | Need a repo admin | B3 |
| Google Fonts loaded at runtime (a third-party request per visit) | Accepted for testing | readiness checklist 8 |
