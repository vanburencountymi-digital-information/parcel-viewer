# Parcel Viewer: testing-deployment readiness checklist

**Scope.** This covers a **limited testing deployment**: invited testers, not the public. It says what's done, what blocks deployment, and what's knowingly accepted. Every claim has a way to check it.
**Status as of 2026-09-25.** Work lives in stacked PRs #25 → #26 → #27, epic DIC-1851.

---

## 1. Verdict

**Not yet deployable.** The code is in good shape for testing: it is tested end to end, 30 bugs were found and fixed this week, and accessibility passes. What blocks a deploy is now mostly **infrastructure and access policy**, not application bugs:

1. **Access control (Maria, 2026-09-25): "the API should not be public."** At minimum it needs token-based access and rate limiting at both the application and hosting levels. Today the viewer and API are fully public, per the June decision on DIC-320, so this is new work (B1).
2. **DB connection budget.** db-dice has a 25-connection ceiling, but one API instance can open about 28, before Martin's connections. PgBouncer (DIC-316) or a pool-size stopgap is required (B2).
3. **Branch protection and release gates (Maria).** These need a staging environment, which doesn't exist yet (B3).
4. **DIC-1871.** Prod nginx still proxies `/map-buddy-api/` to a local dev container that holds the Anthropic key with no quota (B4).
5. **Hostname defaults** in code say `parcels.dicemi.org`; the decision is `gis.dicemi.org` (B5).
6. **DIC-1862.** The Map Buddy shared quota store is still unanswered. The spend limit is the backstop (B6).
7. **Merge the stack:** #25 → #26 → #27 (B7).

Once those land, what remains is observability (section 5) and docs (section 6). Neither blocks a small invited test, but both should be finished before the audience grows.

---

## 2. Blockers: must be done before any tester gets a URL

### Settled (DIC-1863: Drake's June decisions and Maria's guidance of 2026-09-25)

| Question | Answer | Consequence |
|---|---|---|
| Hostname | `gis.dicemi.org` for the parallel rollout; `gis.vanburencountymi.gov` at launch (county IT does the DNS) | Code defaults must change (B5). *Drake to reconfirm.* |
| Where it runs | GCE VM (e2-small, us-central1), shared with parcel-studio; nginx vhosts by subdomain; **no load balancer** | nginx `limit_req` is the hosting-level limiter; `set_real_ip_from` isn't needed |
| TLS | Terminates on nginx on the VM (Certbot) | *Drake to confirm.* Security headers owner still open |
| DB | db-dice, **25-connection ceiling**; plan is PgBouncer (transaction mode, pool 8) on the VM, Martin direct | See B2 |
| Public or authenticated | **Not public. Token-based access plus rate limiting at the app and hosting levels** (Maria; overrides the June "fully public" decision) | See B1 |
| Branch protection | No pushes to `main`; all tests pass; staging deploy passes; up to date with `main` or a merge queue; semantic versioning; Dependabot; security scan (Maria) | See B3 |

### Blockers

| # | Item | Ticket | Owner | Check |
|---|---|---|---|---|
| B1 | **Access control.** Maria requires token-based access plus rate limiting at both levels. The rate limiting exists: slowapi in the app, nginx `limit_req`. **The token part doesn't.** A browser app can't keep a shared secret, so for a *testing* deployment the practical options are: (a) gate the whole testing site in nginx with per-tester credentials (basic auth or an issued access link), or (b) a small token service issuing short-lived per-tester tokens that the viewer sends as a header. **Needs Maria to confirm the scope** (parcel API only, or Map Buddy too) **and the approach.** It also covers the admin gate (Q4) and data exposure (Q10). | DIC-1863 → new ticket | Maria (decision), Jerry (build) | Anonymous `curl $VIEWER/api/parcels?bbox=…` returns 401 |
| B2 | **DB connections.** 2 uvicorn workers × (10 read + 4 config-store) ≈ 28 per API instance, against a 25-connection ceiling, plus Martin. Either land PgBouncer (DIC-316, Backlog) or stopgap with env: `PV_POOL_MAX=5`, giving about 18 per instance. Confirm the instance count. | DIC-316 | Drake / Jerry | `SELECT count(*) FROM pg_stat_activity` under load stays < 25 |
| B3 | **Branch protection and release gates** (Maria's list). Needs: a **staging environment** (none exists; needs an owner), semantic versioning, Dependabot, a security scan (CodeQL or Semgrep), and required checks. Dependabot, CodeQL and semantic-release are repo files and can be added in a PR; the ruleset and staging need a repo admin and infra. | DIC-1863 Q9 | Maria / Drake (admin), Jerry (repo files) | Settings → Rules shows the ruleset; a PR without green checks can't merge |
| B4 | Keep the dev `/map-buddy-api/` proxy out of prod nginx; ship a prod compose without the `map-buddy` service; smoke-check that `$VIEWER/map-buddy-api/status` is **not** 200 | DIC-1871 | Jerry | `curl -o /dev/null -w '%{http_code}' $VIEWER/map-buddy-api/status` returns 404 |
| B5 | Hostname defaults: `PV_CORS_ORIGINS` (`backend/app/main.py`), `PARCEL_API_BASE` and `ALLOWED_ORIGINS` (`map-buddy/deploy.sh`), `infra/DEPLOY-CHECKLIST.md`, `infra/smoke-test.sh` all say `parcels.dicemi.org` / `map.dicemi.org`. They should be `gis.dicemi.org`, and later the county domain. | DIC-1871 | Jerry (after Drake confirms) | Map Buddy works from the live origin (CORS) |
| B6 | Map Buddy cost control: shared quota store, client IP on Cloud Run, dev endpoints (`/judge`, `/autoconfigure`), min instances. *No answers yet. The Anthropic spend limit is the backstop.* | DIC-1862 | Drake | Quota survives an instance restart |
| B7 | Merge #25 → #26 → #27 (stacked). Rebuild the `api` and `map-buddy` images from `main`. | — | Jerry | `gh pr checks` green |
| B8 | *Conditional (only if `PV_WRITER_DATABASE_URL` is set in prod; Q6 still open):* the config-store outage path hangs about 10s and leaks a pool when the writer DB is down | DIC-1872 | Jerry | Stop the writer DB; `/api/config.js` < 1s, failure logged |

**Still open on DIC-1863:** security-headers owner (Q3), admin gate (Q4, likely folded into B1), writer role in prod (Q6), static caching (Q7), non-root containers and health checks (Q8), data exposure (Q10), and the number of API instances (Q5).

## 3. Strongly recommended before testers (security and robustness)

From DIC-1872 and DIC-1871. None of these is a blocker for a small invited group, but each is a known hole.

- [ ] **`/wms-proxy` follows redirects to any host**, which bypasses the allowlist (SSRF). Don't follow 30x, allow only http/https, allowlist response content types, and cap the response size.
- [ ] **Rate-limit `/tiles/` and `/aerial/`.** Tiles are live PostGIS queries that carry owner names; aerial is an open Esri proxy.
- [ ] **Return 400, not 500, for bad input:** township id type, degenerate drawn polygons, out-of-range lng/lat.
- [ ] **`/admin/discover/layers` is public** and runs `count(*)` on every geo table. Require the admin token.
- [ ] **`/health` returns 200 when the DB is down.** Make it non-200 so the platform can restart or route around the instance.
- [ ] **Least-privilege env in compose.** `api` and `martin` currently receive the Anthropic key; `map-buddy` receives the DB DSNs.
- [ ] **Harden `deploy.sh`:** `set -euo pipefail`, refuse a dirty tree, tag images with the git SHA, and stop `--set-env-vars` from wiping other variables.

## 4. What has been verified (and how to re-run it)

### Automated tests

| Suite | Count | Runs in CI? | Command |
|---|---|---|---|
| Engine / viewer unit tests (Node) | **187** pass | yes (`harness`) | `cd engine && node --test` |
| Python contract tests (explainer, cohort SQL, quota, cache, citations, KB, parcel store, workflow params) | **8** files pass | yes | see `.github/workflows/isv-harness.yml` |
| Browser end-to-end (Playwright, Edge) | **169** tests in 24 files | **no:** needs a database (see 7) | `cd e2e && npm install && npx playwright test` |
| Accessibility (axe-core, WCAG 2.1 A/AA) | 0 violations on the scanned screens | with e2e | `npx playwright test tests/a11y-scan.spec.js` |

Full e2e run on 2026-09-25 (23 min, 2 workers, run alone): **166 passed, 2 skipped** (the paid AI tests, gated on `E2E_AI=1`), **1 failed.** The failure was a FEMA 502 through `/api/wms-proxy` during `describe_neighborhood`: a third-party outage, in a spec that was missing the URL-scoped allowance the other federal-data specs have. The allowance is now added and that test passes.

**What the e2e suite covers** (details in `e2e/README.md`):
- search and the parcel panel;
- map clicks and every Map Buddy command (verified to release the map afterwards);
- every tool window and every select, measure and draw tool, with measurements checked against Turf;
- layers, choropleth views, parcel labels and settings;
- bookmarks, share links and deep links;
- Neighborhood Profile, Compare, and flood identify (with a mocked FEMA proxy);
- explainers with AI off, AI failing and AI on (mocked; no model cost);
- Map Buddy automations;
- the admin console;
- simulated failures of style, config, search, parcel and Map Buddy;
- dark mode, accessibility settings, blocked browser storage, and a phone viewport.

**Every test fails on any console error or uncaught exception**, unless that test names the specific error it expects. Silent breakage is what this suite hunts.

**Regression tests are checked against the old code.** For the fixes where it matters most, the test was run against the pre-fix code and confirmed to fail. Examples: the dimension popup, the draw-tool freeze, the flood-popup race, the explainer AI state, and automation limits.

### Bugs found and fixed this week (PRs #25 to #27)

Highlights. The full list is in the PR comments.

- **Map Buddy**
  - Blocking calls froze the whole server during AI requests.
  - Broken chat sessions.
  - Its dimension popup wouldn't close.
  - The draw tool froze the map.
- **Engine selection manager** dropped each feature's geometry and PIN. As a result the panel's Center row never showed, and tools were keyed by internal id.
- **Selection CSV export** allowed spreadsheet formula injection.
- **Share links** ignored the saved view.
- **Rapid clicks** could show a stale flood popup.
- **Plain view:** selecting a parcel made the others disappear.
- **Explainers** said "AI is off" when AI was actually unreachable.
- **Automations** accepted a negative or absurd setback, and reported success when refused.
- **Accessibility:** a critical tablist ARIA error, plus 3 low-contrast colors.
- **Minor fixes:**
  - WebSocket reconnect spam;
  - silent parcel-load failures;
  - blank map when browser storage is blocked;
  - unescaped PINs;
  - dialog keyboard handling;
  - stale search results;
  - NaN bars in the chart.

### Checked by hand (can't be automated)

- **Print.** It opens the browser print dialog. Check once on the deployed host.
- **Street View.** It opens Google Maps in a new tab.
- **The real Map Buddy model.** Run `E2E_AI=1 npx playwright test tests/ai-chat.spec.js`, which costs a few cents. Prompt caching was verified: `cache_read = 9299` tokens.

## 5. Observability: **the weakest area. Be honest with testers about it.**

Current state (verify with `grep -rnE "\blog(ger)?\.(info|warning|error|exception)" backend map-buddy/backend`):

- **Logging is sparse.** There are 4 log calls in the parcel API and 6 in Map Buddy. Errors are logged with `log.exception` and return generic messages, so no stack traces reach clients. Successes and slow requests are not logged.
- **No request IDs.** You can't correlate a browser error with a server log line.
- **No structured (JSON) logs, no metrics, no error tracking.** Nothing like Sentry is configured.
- **Health checks.**
  - Parcel API `/health` reports `db: true|false` but always returns 200.
  - Map Buddy has `/health` and `/status`.
  - nginx uses its default access log.

**Minimum for a testing deployment** (roughly a day's work; suggest a ticket):
- [ ] A request-ID middleware in both FastAPI apps. Accept or generate `X-Request-ID`, return it, and include it in every log line. nginx passes `$request_id`.
- [ ] One JSON access-log line per request: method, path, status, duration, request ID. Cloud Logging parses JSON natively.
- [ ] Log 4xx/5xx with the reason; log DB timeouts, pool exhaustion and AI failures as warnings, with counts.
- [ ] Make `/health` return 503 when the DB is down.
- [ ] Map Buddy: log daily AI spend and quota hits per tenant, to watch cost during testing.
- [ ] Browser errors: a tiny `window.onerror` / `unhandledrejection` beacon to an API endpoint (rate-limited), so tester-side breakage is visible.
- [ ] Uptime check on `/health` for both services, with alerting to email or chat.

## 6. Documentation

| Doc | State |
|---|---|
| `README.md`, `e2e/README.md` | current |
| `infra/DEPLOY-CHECKLIST.md`, `infra/HANDOFF-DRAKE-DEPLOY.md` | current as of the #16–#21 hardening. DIC-1871 lists missing env vars (SMTP, `WMS_PROXY_RATE_LIMIT`, `KB_*`) |
| `docs/HANDOFF.md` | **stale** (2026-06-11; wrong localhost line) |
| `docs/admin-console-provisioning.md` | current |
| **ARCHITECTURE.md** | **missing.** Should cover services, data flow, the AI boundary (facts vs. narration), and the engine vs. viewer split |
| **SECURITY.md** | **missing.** Should cover the threat model, what's public, secrets and where each lives, rate limits, admin gate, CSP status, and the data-exposure decision |
| **RUNBOOK.md** | **missing.** Should cover deploy, rollback, rotating the Anthropic key, what to do when the DB is down, Map Buddy over quota, a FEMA/USFWS outage, and reading the logs |

## 7. Known issues accepted for the testing window

| Issue | Impact | Tracking |
|---|---|---|
| **Assessed-value year labels** come from the calendar year, not the tax roll. They go off by one if the calendar year changes before a data refresh. | Wrong year labels, including in AI narration | DIC-1878 |
| **E2E suite isn't in CI.** It needs a fixture database. | Regressions caught only when someone runs it locally | suggest: seed a small PostGIS fixture |
| **No endpoint tests in CI** for either FastAPI app | Server-side regressions can slip | DIC-1874 |
| **Google Fonts loaded at runtime.** An outage causes console errors, and every visit sends a request to Google. | Minor; privacy | self-host the font |
| **CSP is report-only** | No script-injection enforcement yet | enforce after a clean report period |
| **Annotation store has no persistence** | Drawings are per-session | product decision |
| **Parcel Packet is sample content** | Testers may think it's real | brief testers |
| **Admin console could be served stale** to anyone who loaded it before the `no-store` header existed | Old UI until a hard refresh | tell staff to hard-refresh once |
| Rare **third-party outages** (FEMA, USFWS, NRCS map services) | Overlay tiles or identify missing | none: not ours; shown as "unavailable" |

## 8. Sign-offs needed

- [ ] **Maria:** access-control scope and approach (B1): parcel API only or Map Buddy too; site gate or token service.
- [ ] **County: data exposure (Q10).** Owner names, mailing addresses and owner-name search. Partly resolved if B1 puts the site behind tester access.
- [ ] **Drake:** reconfirm the hostname and TLS; answer DIC-1862 and the open DIC-1863 questions; own PgBouncer (DIC-316) or approve the pool stopgap.
- [ ] **Staging environment owner** (needed for Maria's release gate).
- [ ] **Maria or Drake:** apply the branch ruleset.
- [ ] **Engineer review:** this checklist plus PRs #25 to #27.
