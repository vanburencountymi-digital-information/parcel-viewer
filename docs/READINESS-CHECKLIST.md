# Parcel Viewer: testing-deployment readiness checklist

**Scope.** This covers a **limited testing deployment**: invited testers, not the public launch. It says what's done, what blocks deployment, and what's knowingly accepted. Every claim has a way to check it.
**Status as of 2026-10-23** (main `30a389e`; epic DIC-1851). The September PR stack (#25–#38) is merged. Since then the backend moved to Django (DIC-2146) and hosting moved to Cloud Run (DIC-1863, 2026-10-19).

---

## 1. Verdict

**The application code is ready for an invited test. Deployment is blocked on hosting design, repo admin settings and infrastructure, not on the code.**

What changed since 2026-09-26:
- **The Django API is the only backend.** It reaches contract parity with the old API (DIC-2147 replay harness, ADR 0011). Staff sign in with Knox tokens (ADR 0013), Django admin edits county config (ADR 0014), and each county has a daily budget of detailed parcel records (ADR 0015). FastAPI was retired on 2026-10-14 (DIC-2150).
- **Access control is settled (was B1).** The public viewer is read-only, with no site-wide password, protected by rate limiting at the app and hosting levels. Knox tokens guard staff and admin routes only (Maria and Drake, DIC-1863, 2026-10-19).
- **Data exposure is settled (was Q10).** Owner names, owner mailing addresses and owner-name search are public (Jerry, 2026-10-16).
- **Hosting moved to Cloud Run**, a separate service in its own GCP project, not the shared VM (Maria, Drake agreed, DIC-1863, 2026-10-19). The deploy files were written for the VM. Section 2 lists what has to change.
- **Front end:** bundled by Vite with no CDN scripts (DIC-2180). MapLibre 6.14 fixes the critical `DOM.sanitize` XSS advisory (DIC-2379). Panels are moving to Vue one at a time (DIC-2389, ADR 0017).

What still blocks a deploy:
1. **Cloud Run hosting design** (B9, new): tiles, host-level rate limiting, DB connections, TLS and domain.
2. **Repo admin settings and staging** (B3): all still off.
3. **Map Buddy cost control** (B6): no shared quota store yet; set the Anthropic spend limit first.
4. **Monitoring infrastructure** (section 5): no Sentry project, uptime checks or backups yet.

---

## 2. Blockers: must be done before any tester gets a URL

### Settled

| Question | Answer | Source |
|---|---|---|
| Hostname | `gis.dicemi.org` for the parallel rollout; `gis.vanburencountymi.gov` at launch (county IT does the DNS) | DIC-1863 Q1. *Drake to reconfirm under Cloud Run* |
| Where it runs | **Cloud Run, its own GCP project**, separate from parcel-studio. Replaces the June plan (shared e2-small VM, nginx vhosts, Certbot) | Maria 2026-10-19, Drake agreed |
| Public or authenticated | **Public read-only viewer, rate-limited**; no site-wide password. Knox tokens for staff and admin routes | Maria 2026-10-19, Drake agreed; replaces the 2026-09-25 "not public" guidance |
| Data exposure (Q10) | Owner names, mailing addresses and owner-name search are public | Jerry 2026-10-16 |
| Backend | Django + GeoDjango in `api/`, read-only parcel models, its own config DB | DIC-2146, ADRs 0004–0016 |
| Branch protection | No pushes to `main`; all tests pass; staging deploy passes; up to date with `main` or a merge queue; semantic versioning; Dependabot; security scan (Maria) | Repo side done; admin side is B3 |

### Blockers

| # | Item | Ticket | Owner | Check |
|---|---|---|---|---|
| ~~B1~~ | ~~Access control~~: **settled** (see above). The Django API already limits public routes per IP (`api/common/throttles.py`) and gates admin writes and API docs behind staff tokens (ADRs 0008, 0009) | DIC-1863 | — | Server tests: admin gate, docs 404, throttles |
| B2 | **DB connections.** The VM stopgap (1 worker, pool of 5, at most 17 connections, measured 14 under full e2e) assumed one instance. On Cloud Run the budget is per instance × max instances, so cap `--max-instances` and the per-instance pool together against db-dice's 50 (47 usable), or put PgBouncer / the Cloud SQL connector in front | DIC-1884 (done), DIC-316 | Drake | Peak connections under the full e2e load against staging stay inside the agreed budget |
| B3 | **Repo admin settings and staging.** Checked 2026-10-23 through the GitHub API: **no rulesets; secret scanning, push protection and Dependabot security updates all disabled; no releases published.** Still needed from an admin: <br>• main ruleset (required checks, PRs only, up to date); <br>• secret scanning + push protection; <br>• Dependabot security updates; <br>• the Semgrep app; <br>• the release app and its secrets (semantic release, ADR 0002); <br>• **a staging environment with an owner** | — | Maria / admin | `gh api repos/vanburencountymi-digital-information/parcel-viewer --jq .security_and_analysis`; `gh release list` |
| ~~B4~~ | ~~Dev `/map-buddy-api/` proxy in prod nginx~~: **done (DIC-1871).** Keep the 404 when the web tier moves to Cloud Run | DIC-1871 | — | `infra/smoke-test.sh` |
| ~~B5~~ | ~~Hostname defaults~~: **done (DIC-1871).** Code defaults are `gis.dicemi.org` | DIC-1871 | Drake (confirm) | Map Buddy works from the live origin (CORS) |
| B6 | **Map Buddy cost control:** shared quota store, client IP on Cloud Run, dev endpoints, min instances. *No answers yet.* The Anthropic monthly spend limit is the backstop and must be set first. Last checked 2026-09-25, the deployed Map Buddy was an old build (quota off, `/docs` public): redeploy with `map-buddy/deploy.sh` | DIC-1862 | Drake | Quota survives an instance restart; smoke test passes against Map Buddy |
| B7 | ~~Merge the September stack~~: **done.** Now: build the `django-api`, `web` and `map-buddy` images from a release tag (`APP_VERSION`) and run the Django migrations | — | Jerry | `gh pr checks` green on the release commit |
| ~~B8~~ | ~~Config-store outage path~~: **done in #31**, ported to Django (ADR 0010) | DIC-1872 | — | — |
| B9 | **Cloud Run hosting design (new).** The deploy files assume one VM running Docker Compose. Each piece needs a Cloud Run answer: <br>• **web tier:** nginx serves the static bundle, security headers and `/api/` routing; it becomes its own Cloud Run service, or a Cloud Storage bucket behind a load balancer; <br>• **tiles:** Martin runs next to the API in `docker-compose.prod.yml`; it needs its own service or a tile cache; <br>• **host-level rate limiting:** nginx `limit_req` on `/tiles/` and `/aerial/` was the hosting-level limiter; on Cloud Run that's Cloud Armor (needs a load balancer) or nginx kept as the front service; <br>• **client IP:** app throttles must read the address the load balancer gives, not the proxy hop; <br>• **TLS and domain:** Cloud Run domain mapping or the load balancer, not Certbot; <br>• **secrets:** Secret Manager for `DJANGO_SECRET_KEY`, the DB passwords, `SENTRY_DSN`; <br>• **config DB:** where `django-db` lives (it's a container on the VM today). <br>Then update `infra/DEPLOY-CHECKLIST.md`, `infra/HANDOFF-DRAKE-DEPLOY.md`, `SECURITY.md` and `infra/smoke-test.sh` | DIC-1863, DIC-1856 | Drake + Jerry | A staging deploy passes `infra/smoke-test.sh` |

**Still open on DIC-1863:** security-headers owner (Q3), writer role in prod (Q6), static caching (Q7), number of API instances (Q5, now part of B2). Q4 (admin gate) is answered by Knox staff sign-in. **Q8** (non-root containers + health checks) is done in code (#28).

## 3. Security and robustness

**Done (#28–#31, carried into the Django port):**
- [x] `/wms-proxy`: HTTPS and allowlisted hosts only; **no redirects** (was SSRF); map-data content types only; 5 MB cap; upstream bodies never reflected (#29, ported in DIC-2149).
- [x] Bad input → **400, never a PostGIS 500**: coordinates, drawn polygons, buffer size, township/school ids (#31; request validation in ADR 0012).
- [x] Admin writes check the staff token **before** any database work. Each staff account can edit only its own counties; the shared admin key is retired (DIC-2151).
- [x] API docs are staff-only; everyone else gets the same 404 as an unknown path (ADR 0009).
- [x] `/health` returns 503 when the DB is down, and the pool recovers on its own (#28, #31).
- [x] No query strings (owner-name searches) in app or nginx logs; no personal data sent to Sentry (#28, #29).
- [x] Log-injection, prototype-pollution and format-string findings fixed (#29). `/config.js` doesn't reflect its input. The public `/history` drops staff IDs and notes (#31).
- [x] Per-county daily budget of detailed parcel records (open / observe / protected), to deter bulk resale (DIC-2197, ADR 0015).

**Done (DIC-1871, DIC-2180, DIC-2379):**
- [x] `/tiles/` and `/aerial/` are rate-limited in nginx (60 req/s per IP, burst 300). **Needs a Cloud Run equivalent (B9).**
- [x] Least-privilege env: each service gets only the settings it reads; `api` never receives the Anthropic key.
- [x] `deploy.sh` hardened: refuses a dirty tree, tags images with the git SHA, `--update-env-vars`.
- [x] MapLibre, Turf and proj4 are bundled from npm, so the CSP lists no CDN (DIC-2180). MapLibre 6.14 fixes the critical `DOM.sanitize` XSS advisory (DIC-2379).

**Open:**
- [x] The one open CodeQL alert (`js/unused-local-variable`, `admin-menu.js`) is fixed; it closes when DIC-2552 merges and CodeQL re-scans `main`.
- [x] `.github/dependabot.yml` pointed at `/backend`, deleted with FastAPI, so that update job failed weekly. It now covers `/api` (pip and docker) like the other services (DIC-2552).

## 4. What has been verified (and how to re-run it)

### Automated tests and scans

| Check | Size | In CI? | Command |
|---|---|---|---|
| Engine / viewer unit tests (Node) | ~200 tests | yes (`harness`) | `cd engine && node --test` |
| Vue component tests (Vitest) | 13 files | yes (`web-image`) | `npm test` (repo root) |
| Django API tests, against PostGIS | ~215 tests | yes (`django-api`, with a `postgis/postgis` service) | `cd api && python manage.py test` |
| Django: ruff, mypy, migrations up to date, shared modules match Map Buddy's | pass | yes (`django-api`) | see `.github/workflows/isv-harness.yml` |
| Map Buddy server tests (FastAPI TestClient; no DB, no model) | ~65 tests | yes (`server-tests`) | `cd map-buddy/backend && pytest -q` |
| Docker image builds (`django-api`, `map-buddy`, `web`) | build | yes (`docker-build`, `web-image`) | see the workflow |
| nginx config and compose files valid; production has no local Map Buddy | pass | yes (`infra-config`) | see the workflow |
| Lint, format, types, secrets (pre-commit) | pass | yes (`Lint`) | `pre-commit run --all-files` |
| CodeQL (Python, JS/TS, Actions) | 1 open alert | yes (`CodeQL`, + weekly) | Security → Code scanning |
| Browser end-to-end (Playwright; Edge locally, Chromium in CI) | 30 spec files | yes (`E2E`, 8 shards, on the seeded fixture database `e2e/fixture`; DIC-2553) | `cd e2e && npm install && npx playwright test` |
| Accessibility (axe-core, WCAG 2.1 A/AA) | 0 violations on the scanned screens | with e2e | `npx playwright test tests/a11y-scan.spec.js` |

**Latest full e2e run (2026-10-16, #100):** 237 passed, 2 failed. Both failures were the choropleth parcel-index race, which passed 6/6 on rerun and is fixed in #99 (DIC-2459). The paid AI tests are skipped unless `E2E_AI=1`.

**Every e2e test fails on any console error or uncaught exception**, unless that test names the specific error it expects. Key regression tests were confirmed to fail against the pre-fix code. `e2e/README.md` lists what the suite covers.

### Checked by hand (can't be automated)

- **Print.** It opens the browser print dialog. Check once on the deployed host.
- **Street View.** The embed needs the Google Maps Embed key in the Admin Console (DIC-534).
- **The real Map Buddy model.** Run `E2E_AI=1 npx playwright test tests/ai-chat.spec.js` (a few cents).

## 5. Observability (DIC-1879, ADR 0001)

- [x] **Request ids** on every response and log line, linking nginx, app and browser.
- [x] **Logs:** JSON in the images, text locally. No query strings.
- [x] **Sentry:** a no-op until `SENTRY_DSN` is set. PII is scrubbed.
- [x] **Warnings instead of Sentry reports** for DB busy, AI quota hits, federal map-service outages and config-store backoff.
- [x] **Honest health checks;** non-root containers with Docker `HEALTHCHECK`.
- [x] **AI cost** logged per model call; **browser JS errors** reported via `pv-error-beacon.js`.
- [x] **The release version** reaches the apps from the git tag (#30).
- [ ] **Needs infra:**
  - a Sentry project, with its DSN in Secret Manager (`dice-sentry-dsn`) and `SENTRY_ENVIRONMENT`;
  - uptime checks on the `/health` endpoints, with alert routing;
  - DB backups with a quarterly restore test (the Django config DB is new and needs its own).

## 6. Team standards (Maria's Engineering Tooling docs)

| Standard | Status |
|---|---|
| Tests on every PR; build must succeed | **Done:** harness, server-tests, django-api, docker-build, web-image, infra-config |
| Lint / format / type checks in CI; pre-commit | **Done:** ruff, mypy, gitleaks, conventional commits (ADR 0003) |
| Semantic versioning (python-semantic-release, VBCD app) | **Done in repo** (ADR 0002); **admin:** install the app + secrets. No release published yet |
| CodeQL; review critical/high | **Done;** 1 open alert to triage |
| Dependabot (grouped, through CI) | **Done:** config; **admin:** enable security updates. Stale `/backend` entry replaced by `/api` (DIC-2552) |
| Secret scanning + push protection | **Admin:** off (checked 2026-10-23) |
| Semgrep | **Admin:** add the repo to the SemGrep - vbcd app |
| Gitleaks (history + pre-commit) | **Done** |
| Branch ruleset (PRs only, checks, up to date / merge queue) | **Admin:** none (checked 2026-10-23) |
| Staging deploy gate; prod via manual approval | **Needs an owner + infra** (B3, B9) |
| Error monitoring (Sentry), uptime, alerts | **Code done;** infra open (section 5) |
| Check auth first, fail immediately | **Done** for admin routes |
| Rate limiting at app **and** hosting level | **App: done** (Django throttles). **Hosting: done on nginx, needs a Cloud Run equivalent** (B9) |
| ADRs in `docs/adrs/` | **Done:** 0001–0017 |
| Public API access | **Settled:** public read routes with rate limits; Knox for staff and admin |

## 7. Documentation

| Doc | State |
|---|---|
| `README.md`, `e2e/README.md` | current |
| `ARCHITECTURE.md`, `SECURITY.md`, `docs/RUNBOOK.md` | updated through the Django port (2026-10-16); **still describe VM hosting** — update with B9 |
| `infra/DEPLOY-CHECKLIST.md` | current for the Django API (2026-10-15); **written for the VM** — update with B9 |
| `infra/HANDOFF-DRAKE-DEPLOY.md`, `docs/admin-console-provisioning.md` | check against the Cloud Run plan |
| `docs/adrs/` | 0001–0017; Cloud Run hosting needs an ADR |

## 8. Known issues accepted for the testing window

| Issue | Impact | Tracking |
|---|---|---|
| ~~**E2E suite isn't in CI**~~ **Fixed:** the `E2E` workflow runs the whole suite on every PR against a seeded fixture database (1,773 parcels around Paw Paw, owners replaced by stand-ins) | CI covers the fixture area only; runs against staging or the real data stay a manual check | DIC-2553 |
| **CSP is report-only** | No script-injection enforcement yet | enforce after a clean report period |
| **mypy exemption list** for pre-existing modules | Type-checked but not fully annotated | ADR 0003 |
| **Annotation store has no persistence** | Drawings are per-session | product decision |
| **Parcel Packet is sample content** | Testers may think it's real | brief testers |
| **Assessed-value roll year is inferred** from the data's load date | Overridable with `assessing.rollYear` | DIC-1878 |
| Rare **third-party outages** (FEMA, USFWS, NRCS) | Overlay tiles or identify missing. FEMA flood zones now come from our own DB (DIC-2414) | logged as warnings |
| **Front end is part Vue, part classic scripts** | Two patterns during the migration | DIC-2389 |

## 9. Sign-offs needed

- [ ] **Drake + Jerry:** the Cloud Run hosting design (B9): web tier, tiles, host-level rate limiting, TLS, config DB, secrets; record it as an ADR.
- [ ] **Drake:** the DB connection budget under Cloud Run (B2); reconfirm the hostname; answer DIC-1862 (B6).
- [ ] **Maria or an admin:** the repo settings in B3 (ruleset, secret scanning, push protection, Dependabot security updates, Semgrep, release app).
- [ ] **Staging environment owner** (Maria's release gate).
- [ ] **Anthropic monthly spend limit** set before any URL goes out.
- [ ] **Sentry project and DSN**, uptime checks, backups.
- [x] ~~**County: data exposure (Q10)**~~: decided 2026-10-16.
- [x] ~~**Maria: access-control scope and approach (B1)**~~: decided 2026-10-19.
