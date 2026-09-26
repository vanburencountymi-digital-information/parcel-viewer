# Parcel Viewer: testing-deployment readiness checklist

**Scope.** This covers a **limited testing deployment**: invited testers, not the public. It says what's done, what blocks deployment, and what's knowingly accepted. Every claim has a way to check it.
**Status as of 2026-09-26.** Work lives in stacked PRs #25 → #26 → #27 → #28 → #29 → #30 → #31 → #32 (epic DIC-1851). Merge them in that order.

---

## 1. Verdict

**The application code is ready for an invited test. Deployment is blocked on decisions and infrastructure, not on the code.**

The code side covers:
- a 172-test browser suite, plus server tests in CI;
- about 60 bugs and security findings fixed this week (30 bugs in #25–#27, 17 CodeQL security findings and 3 more bugs in #29, about 10 in #31);
- clean accessibility, CodeQL and gitleaks scans;
- observability;
- Maria's in-repo standards: pre-commit, CodeQL, Dependabot, semantic release.

What still blocks a deploy:

1. **Access control (Maria: "the API should not be public").** It needs token-based access plus rate limiting at the app and hosting levels. The rate limiting exists; the token part needs Maria's choice of scope and approach (B1).
2. **DB connection budget:** stopgap **in place** (DIC-1884). The production compose defaults to 1 worker and a pool of 5 (at most 17 connections). It was measured at 14 under the full e2e load, with no slowdown. db-dice's real `max_connections` is 50, not 25. PgBouncer (DIC-316) is still the lasting fix (B2).
3. **Repo admin settings and staging (Maria's release gate)** (B3):
   - the branch ruleset;
   - secret scanning and push protection;
   - Dependabot security updates;
   - the Semgrep app;
   - the release app;
   - a staging environment.

   The repo is already public; the history scan is clean.
4. ~~**DIC-1871 infra**~~ (B4, B5): **done in code (#32).** Production has its own compose file and nginx snippet; hostname defaults are `gis.dicemi.org`. Drake still needs to reconfirm the hostname.
5. **DIC-1862.** Map Buddy's shared quota store is unanswered; the Anthropic spend limit is the backstop (B6).
6. **Merge the stack** (B7).

---

## 2. Blockers: must be done before any tester gets a URL

### Settled (DIC-1863: Drake's June decisions and Maria's guidance of 2026-09-25)

| Question | Answer | Consequence |
|---|---|---|
| Hostname | `gis.dicemi.org` for the parallel rollout; `gis.vanburencountymi.gov` at launch (county IT does the DNS) | Code defaults changed (B5, DIC-1871). *Drake to reconfirm.* |
| Where it runs | GCE VM (e2-small, us-central1), shared with parcel-studio; nginx vhosts by subdomain; **no load balancer** | nginx `limit_req` is the hosting-level limiter; `set_real_ip_from` isn't needed. nginx re-resolves container names (#29), which **assumes nginx runs in Docker** |
| TLS | Terminates on nginx on the VM (Certbot) | *Drake to confirm.* Security-headers owner still open |
| DB | db-dice; the June note said a **25-connection ceiling**, but the server's `max_connections` is **50** (checked 2026-09-26; *Drake to confirm which budget applies*); plan is PgBouncer (transaction mode, pool 8) on the VM, Martin direct | See B2 |
| Public or authenticated | **Not public. Token-based access plus rate limiting at the app and hosting levels** (Maria; overrides the June "fully public" decision) | See B1 |
| Branch protection | No pushes to `main`; all tests pass; staging deploy passes; up to date with `main` or a merge queue; semantic versioning; Dependabot; security scan (Maria) | Repo side done (#28–#30); admin side is B3 |

### Blockers

| # | Item | Ticket | Owner | Check |
|---|---|---|---|---|
| B1 | **Access control.** A browser app can't keep a shared secret, so for a *testing* deployment the options are: (a) gate the whole testing site in nginx with per-tester credentials, or (b) a small token service issuing short-lived per-tester tokens. **Asked Maria on 2026-09-25 (DIC-1863) to choose, and to set the scope** (parcel API only, or Map Buddy too). It also covers the admin gate (Q4) and data exposure (Q10). | DIC-1863 → new ticket | Maria (decision), Jerry (build) | Anonymous `curl $VIEWER/api/parcels?bbox=…` returns 401 |
| ~~B2~~ (stopgap) | **DB connections: stopgap done (DIC-1884); PgBouncer still open.** The production compose now defaults to 1 worker + a read pool of 5: at most 17 connections (5 + 4 config + 8 Martin), measured at **14** under the full e2e load, with no slowdown. The old defaults could reach 36. db-dice allows 50 (47 usable), other clients held up to 16, and the total peaked at 27 during the run. The viewer's connections are now named in `pg_stat_activity`. Drake: confirm the budget and whether one API instance runs. | DIC-316, DIC-1884 | Drake | `SELECT application_name, count(*) FROM pg_stat_activity GROUP BY 1` under load |
| B3 | **Repo admin settings and staging.** The repo side is **done**: CI runs server tests, Docker builds, CodeQL, lint/type/secret hooks and semantic release; Dependabot config is in place. Still needed from an admin: <br>• **main ruleset** (required checks, PRs only, up to date); <br>• **secret scanning + push protection**; <br>• **Dependabot security updates**; <br>• add the repo to the **SemGrep - vbcd** app; <br>• install the **VBCD Semantic Release App** with `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` and a ruleset bypass; <br>• a **staging environment** and its owner. | DIC-1863 Q9, DIC-1880, DIC-1881 | Maria / Drake | Settings → Rules shows the ruleset; a PR without green checks can't merge; first merge creates a `v*` tag |
| ~~B4~~ | ~~Dev `/map-buddy-api/` proxy in prod nginx~~: **done (DIC-1871).** `infra/docker-compose.prod.yml` has no `map-buddy` service and mounts `infra/nginx/map-buddy-api.prod.conf` (a 404); the smoke test fails if that route answers. | DIC-1871 | — | `curl -o /dev/null -w '%{http_code}' $VIEWER/map-buddy-api/status` returns 404 |
| ~~B5~~ | ~~Hostname defaults~~: **done (DIC-1871).** `PV_CORS_ORIGINS`, `deploy.sh` (`VIEWER_ORIGINS`, `PARCEL_API_BASE`), the deploy docs and the smoke test default to `gis.dicemi.org`. Drake to reconfirm. | DIC-1871 | Drake (confirm) | Map Buddy works from the live origin (CORS) |
| B6 | Map Buddy cost control: shared quota store, client IP on Cloud Run, dev endpoints (`/judge`, `/autoconfigure`), min instances. *No answers yet; the Anthropic spend limit is the backstop.* | DIC-1862 | Drake | Quota survives an instance restart |
| B7 | Merge #25 → … → #32 (stacked). Rebuild the `api` and `map-buddy` images from `main` with `APP_VERSION` from the release tag. If the writer store is used, apply migrations `0001` then `0002`. | — | Jerry | `gh pr checks` green |
| ~~B8~~ | ~~Config-store outage path~~: **done in #31.** The store is built once, fails fast with a 30s backoff, the viewer serves the baked manifest immediately, and one warning is logged. | DIC-1872 | — | — |

**Still open on DIC-1863:** security-headers owner (Q3), admin gate (Q4, likely folded into B1), writer role in prod (Q6), static caching (Q7), data exposure (Q10), number of API instances (Q5). **Q8** (non-root containers + health checks) is **done in code** (#28).

## 3. Security and robustness

**Done (#28–#31):**
- [x] `/wms-proxy`: HTTPS and allowlisted hosts only; **no redirects** (was SSRF); map-data content types only; 5 MB cap; upstream bodies never reflected (#29).
- [x] Bad input → **400, never a PostGIS 500**: coordinates, drawn polygons, buffer size, township/school ids (#31).
- [x] `/admin/discover/layers` requires the admin token and is cached (#31). Admin writes check the token **before** any database work (#31).
- [x] `/health` returns 503 when the DB is down (#28). A dead or lost DB connection → 503 in ~10s and the pool recovers on its own; it used to hang for 60s and need a restart (#31).
- [x] nginx follows containers after a rebuild. It used to send `/api/` traffic to the wrong container (#29).
- [x] No query strings (owner-name searches) in app or nginx logs; no personal data sent to Sentry (#28, #29).
- [x] Log-injection, prototype-pollution and format-string findings fixed; a dev proxy no longer listens on the network (#29).
- [x] `/config.js` 404 no longer reflects its input into a script. The public `/history` drops staff IDs and notes (#31).

**Done (DIC-1871):**
- [x] **`/tiles/` and `/aerial/` are rate-limited** (60 req/s per IP, burst 300; the full e2e suite runs clean under them). `/aerial/` relays only tile paths and caches by tile, so it's no longer an open Esri proxy.
- [x] **Least-privilege env in compose.** Each service lists only the settings it reads: `api` no longer receives the Anthropic key, `martin` sees only its own login, `map-buddy` gets no parcel-DB credentials.
- [x] **`deploy.sh` hardened:** `set -euo pipefail`, refuses a dirty tree, tags images with the git SHA, builds `linux/amd64`, `--update-env-vars` (console-set settings survive), explicit `--concurrency` / `--timeout`, overridable origins and tenant.
- [x] Martin's DB pool capped at 8 (its default was 20). `backend/requirements.txt` is exact-pinned. `.gitignore` covers `.env.*`, keys and service-account JSON. `/` redirects relatively; `*.md` and `/engine/test/` are 404s.

## 4. What has been verified (and how to re-run it)

### Automated tests and scans

| Check | Result | In CI? | Command |
|---|---|---|---|
| Engine / viewer unit tests (Node) | **199** pass | yes (`harness`) | `cd engine && node --test` |
| Python contract tests | **8** files pass | yes (`harness`) | see `.github/workflows/isv-harness.yml` |
| Server tests: parcel API + Map Buddy (FastAPI TestClient; no DB, no model), including the public contract: admin gate, docs off, CORS, input 4xx before the DB, no leaked errors, `/report-error` limits, 413/422 caps, quota on every AI route, server-side tenant, no unreviewed `async` routes (DIC-1874) | **152 + 43** pass | yes (`server-tests`) | `pip install -r requirements-dev.txt && pytest` in `backend/` and `map-buddy/backend/` |
| Docker image builds | both build | yes (`docker-build`) | `docker build backend` / `docker build map-buddy/backend` |
| nginx config (dev + prod snippet) and compose files valid; production has no local Map Buddy | pass | yes (`infra-config`) | see `.github/workflows/isv-harness.yml` |
| Lint, format, types, secrets (pre-commit: ruff, mypy, gitleaks, …) | all **11** hooks pass | yes (`Lint`) | `pre-commit run --all-files` |
| CodeQL (Python, JS/TS, Actions) | **36** findings from the first full scan, all **fixed** (17 security) | yes (`CodeQL`, + weekly) | Security → Code scanning |
| Secret scan, full git history (gitleaks) | **0 leaks** in all 248 non-merge commits | per commit (hook) | `pre-commit run gitleaks --all-files` |
| Browser end-to-end (Playwright, Edge) | **172** tests in 24 files | **no:** needs a database (see 8) | `cd e2e && npm install && npx playwright test` |
| Accessibility (axe-core, WCAG 2.1 A/AA) | 0 violations on the scanned screens | with e2e | `npx playwright test tests/a11y-scan.spec.js` |

**Latest full e2e run (2026-09-26, after #32):** **170 passed, 0 failed, 2 skipped**, with no 429s from the new tile and aerial limits. The skipped two are the paid AI tests, gated on `E2E_AI=1`.

**What the e2e suite covers** (details in `e2e/README.md`):
- search and the parcel panel;
- map clicks and every Map Buddy command and automation;
- every tool window and every select, measure and draw tool, with measurements checked against Turf;
- layers, choropleth views, parcel labels and settings;
- bookmarks, share links and deep links;
- Neighborhood Profile, Compare, and flood identify;
- explainers with AI off, failing and on;
- the admin console;
- simulated backend failures;
- the browser error beacon;
- dark mode, accessibility settings, blocked storage, and a phone viewport.

**Every test fails on any console error or uncaught exception**, unless that test names the specific error it expects.

**Regression tests are checked against the old code.** For key fixes the test was run against the pre-fix code and confirmed to fail. Examples:
- the dimension popup;
- the draw-tool freeze;
- the flood-popup race;
- the explainer AI state;
- automation limits;
- the DMS Copy button;
- `/health` 503.

**Live-verified on the stack:**
- one request id traced from nginx through the API logs;
- a real AI call's cost logged;
- the hardened proxy against real FEMA data;
- nginx following a moved API container;
- a dead-DB-connection 503 plus self-recovery;
- every former 500 input re-probed;
- a Docker build argument reaching the app's version.

### Bugs and findings fixed this week

- **#25–#27 (30 bugs):**
  - Map Buddy blocking the server;
  - broken chat;
  - the dimension popup and draw-tool freeze;
  - the selection manager dropping geometry/PIN;
  - CSV formula injection;
  - share links;
  - the stale flood popup;
  - Plain view hiding parcels;
  - explainers mislabelling "AI off";
  - automation limits;
  - accessibility (a tablist error plus 3 contrasts);
  - smaller UI bugs.
- **#29 (CodeQL, 36 findings):**
  - **SSRF** in `/wms-proxy`;
  - a dev proxy exposed on the network;
  - log injection;
  - error-detail leaks;
  - prototype pollution;
  - a console format string;
  - 19 quality notes, including 115 lines of dead code.

  Found alongside:
  - the **DMS Copy button** copying half a coordinate;
  - **nginx misrouting API traffic after a rebuild**;
  - nginx logging search terms.
- **#31:**
  - the **config-store outage** path;
  - the **dead DB connection** hang;
  - **seven inputs returning 500**, including **school-district profiles crashing**;
  - `/config.js` script injection;
  - a publish race that could duplicate a version.

### Checked by hand (can't be automated)

- **Print.** It opens the browser print dialog. Check once on the deployed host.
- **Street View.** It opens Google Maps in a new tab.
- **The real Map Buddy model.** Run `E2E_AI=1 npx playwright test tests/ai-chat.spec.js` (a few cents). Prompt caching was verified: `cache_read = 9299` tokens.

## 5. Observability (DIC-1879, ADR 0001), done in #28

Built to Maria's standard: Sentry through an injected `ErrorLoggingClient`, like dice-document-pipeline-api. How to use it: `docs/RUNBOOK.md` → "Finding out what went wrong".

- [x] **Request ids** on every response and log line, linking nginx, app and browser.
- [x] **Logs:** JSON in the images, text locally. No query strings.
- [x] **Sentry:** a no-op until `SENTRY_DSN` is set. Unhandled errors, and all caught-and-recovered errors, are reported. PII is scrubbed.
- [x] **Warnings instead of Sentry reports** for load and outages:
  - DB busy or unavailable;
  - AI quota hits;
  - federal map-service outages;
  - writer-store backoff.
- [x] **Honest health checks;** non-root containers with Docker `HEALTHCHECK`.
- [x] **AI cost** logged per model call.
- [x] **Browser JS errors** reported via `pv-error-beacon.js`.
- [x] **The release version** reaches both apps (API version + Sentry release) from the git tag (#30).
- [ ] **Needs infra:**
  - a Sentry project, with its DSN in Secret Manager (`dice-sentry-dsn`) and `SENTRY_ENVIRONMENT`;
  - uptime checks on both `/health` endpoints, with alert routing;
  - DB backups with a quarterly restore test.

## 6. Team standards (Maria's Engineering Tooling docs)

| Standard | Status |
|---|---|
| Tests on every PR; build must succeed | **Done:** harness, server-tests, docker-build (#28) |
| Lint / format / type checks in CI; pre-commit | **Done:** ruff, mypy (strict for new code), gitleaks, conventional commits (#30, ADR 0003) |
| Semantic versioning (python-semantic-release, VBCD app) | **Done in repo** (#30, ADR 0002); **admin:** install the app + secrets + bypass |
| CodeQL; review critical/high | **Done** (#29), and all first-scan findings fixed |
| Dependabot (grouped, through CI) | **Done:** config (#29); **admin:** enable security updates |
| Secret scanning + push protection | **Admin:** currently off |
| Semgrep | **Admin:** add the repo to the SemGrep - vbcd app |
| Gitleaks (history + pre-commit) | **Done:** history clean; hook on every commit (#30) |
| Branch ruleset (PRs only, checks, up to date / merge queue) | **Admin** |
| Staging deploy gate; prod via manual approval | **Needs an owner + infra** |
| Error monitoring (Sentry), uptime, alerts | **Code done** (#28); **infra:** Sentry project, uptime checks |
| Check auth first, fail immediately | **Done** for admin routes (#31) |
| Rate limiting at app **and** hosting level | **Done**: the API (#16–#31), `/tiles/` and `/aerial/` (DIC-1871) |
| ADRs in `docs/adrs/` | **Done:** 0001–0003 |
| Public API not public (token access) | **Decision pending** (B1) |

## 7. Documentation

| Doc | State |
|---|---|
| `README.md` | current, including **Contributing**: pre-commit setup, commit-message → version table, releases |
| `e2e/README.md` | current |
| `infra/DEPLOY-CHECKLIST.md` | current through DIC-1871: prod compose, every API and Map Buddy setting (SMTP, WMS proxy, Sentry, models, caches, `KB_*`), connection budget including Martin |
| `infra/HANDOFF-DRAKE-DEPLOY.md`, `docs/admin-console-provisioning.md` | current |
| `docs/HANDOFF.md` | dated 2026-06-11; its localhost line is correct again now that `/` redirects relatively (DIC-1871). Superseded by `infra/DEPLOY-CHECKLIST.md` for deploys |
| `docs/RUNBOOK.md` | current (DIC-1883): deploying both deployables, rolling back (code, Map Buddy revisions, migrations, config), rotating every secret, and "Finding out what went wrong" |
| `docs/adrs/` | 0001 Observability, 0002 Semantic versioning, 0003 Code checks |
| `ARCHITECTURE.md` | current (DIC-1883): services, request flow, the AI boundary, config and theming, observability, testing, where to change things |
| `SECURITY.md` | current (DIC-1883): threat model, what's public, secrets and who sees them, controls, what reaches Anthropic, open decisions, reporting |

## 8. Known issues accepted for the testing window

| Issue | Impact | Tracking |
|---|---|---|
| ~~Assessed-value year labels from the calendar year~~: **fixed (DIC-1878).** Labels follow the roll year inferred from the data's load date (April onward = that year's roll), overridable with `assessing.rollYear` in county config; the AI is told when the year is only an estimate | Still an inference until the loader records the roll year; confirm with the data owners | DIC-1878 |
| **E2E suite isn't in CI** (needs a fixture database) | Browser-level regressions are caught only when someone runs it | suggest: seed a small PostGIS fixture |
| **mypy exemption list** for pre-existing modules | Those modules are type-checked but not fully annotated | ADR 0003; shrink over time |
| **Google Fonts loaded at runtime** | Minor outage and privacy exposure | self-host the font |
| **CSP is report-only** | No script-injection enforcement yet | enforce after a clean report period |
| **Annotation store has no persistence** | Drawings are per-session | product decision |
| **Parcel Packet is sample content** | Testers may think it's real | brief testers |
| **`kb_store.py` differs from its ZIP-repo twin** after formatting | Re-sync deliberately | noted on #30 |
| Rare **third-party outages** (FEMA, USFWS, NRCS) | Overlay tiles or identify missing | none: not ours; logged as warnings |

## 9. Sign-offs needed

- [ ] **Maria:** access-control scope and approach (B1).
- [ ] **Maria or an admin:** the repo settings in B3 (ruleset, secret scanning, push protection, Dependabot security updates, Semgrep, release app).
- [ ] **County: data exposure (Q10).** Owner names, mailing addresses and owner-name search. Partly resolved if B1 puts the site behind tester access.
- [ ] **Drake:**
  - reconfirm the hostname and TLS;
  - answer DIC-1862 and the open DIC-1863 questions;
  - own PgBouncer (DIC-316) or approve the pool stopgap;
  - confirm nginx runs in Docker on the VM.
- [ ] **Staging environment owner** (needed for Maria's release gate).
- [ ] **Sentry project and DSN**, plus uptime checks.
- [ ] **Engineer review:** this checklist plus PRs #25 to #32.
