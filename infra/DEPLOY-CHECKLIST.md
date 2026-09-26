# Parcel Viewer — deploy-readiness checklist

Target: a live URL for testing at `gis.dicemi.org` during the parallel rollout, moving to
`gis.vanburencountymi.gov` at launch (county IT does the DNS; see
[DIC-1863](https://linear.app/dicelabs/issue/DIC-1863) Q1). The code defaults use `gis.dicemi.org`. Plan and status:
[DIC-1851 Pre-launch hardening](https://linear.app/dicelabs/issue/DIC-1851).

Two deployables:
- **Viewer** — nginx + `api` (FastAPI) + `martin` (tiles). **Production: `infra/docker-compose.prod.yml`** + `infra/nginx.viewer.conf`. `infra/docker-compose.viewer.yml` is the local dev stack (adds a local Map Buddy, API docs and readable logs); don't deploy it.
- **Map Buddy** — the AI service, separate, on **Cloud Run** (`map-buddy/deploy.sh`).

Owner tags: **[repo]** = in-repo, done/doable here · **[infra]** = Drake / hosting · **[verify]** = check before/after.

---

## Before you deploy: open decisions

- **[infra] Hosting answers — [DIC-1863](https://linear.app/dicelabs/issue/DIC-1863).** Hostname, what sits in front of nginx, where TLS terminates, admin gate, DB connection budget, writer role, caching, container runtime, branch protection. Several settings below depend on these.
- **[infra] Map Buddy quota store — [DIC-1862](https://linear.app/dicelabs/issue/DIC-1862).** Until it lands, the AI quota counts in memory per Cloud Run instance (see Map Buddy settings).
- **[infra] Anthropic spend limit.** Set a monthly hard limit in the Anthropic Console before going public. It's the backstop until the shared quota exists.

---

## Critical path

1. **[infra] Deploy current Map Buddy to Cloud Run** — `bash map-buddy/deploy.sh`.
   - ⚠ **Prod is running an old build today** (checked 2026-09-25 with the smoke test): the AI quota is **off**, `/docs` and `/openapi.json` are public, and none of the chat caps are in place. This redeploy fixes all of that; see "Map Buddy settings" below.
   - `deploy.sh` sets `PARCEL_API_BASE`, `MAP_BUDDY_TENANT`, `AI_QUOTA_DEFAULT` / `AI_QUOTA_WINDOW`, and prod-only `ALLOWED_ORIGINS` (from `VIEWER_ORIGINS`; no localhost). Override any of them via the environment, e.g. `VIEWER_ORIGINS=https://gis.vanburencountymi.gov PARCEL_API_BASE=https://gis.vanburencountymi.gov/api bash map-buddy/deploy.sh`.
   - It refuses to run with uncommitted changes, tags the image with the commit (`:<sha>`, so a rollback is `gcloud run deploy --image …:<old-sha>`), builds for `linux/amd64`, and uses `--update-env-vars`, so settings set in the console (for example `SENTRY_DSN`) survive a redeploy (DIC-1871).
   - Key comes from secret `MAP_BUDDY_ANTHROPIC_API_KEY` (already wired).
   - ⚠ **Cold starts:** `--min-instances 0`. The first AI call cold-starts (~seconds). Health-check hysteresis hides a single blip; for the testing window consider `--min-instances 1` (DIC-1862 Q5).

2. **[verify] Viewer points at the deployed Map Buddy URL.** `deploy.sh` prints the Cloud Run URL. It lives in **config only**, in three files, and every browser module resolves it through `frontend/public/js/pv-endpoints.js`:
   - `frontend/public/js/county-config.js` (`endpoints.mapBuddy`)
   - `backend/parcel_viewer/county_configs/vanburen.json` (served as `/api/config.js`; the `api` image is baked, **rebuild it** if changed)
   - `engine/themes/vanburen.json` (`endpoints.mapBuddy` and `mapBuddy.apiBase`)

   Today they read `https://map-buddy-toaozre74a-uc.a.run.app`. If the URL changes, update all three; `engine/test/endpoints.test.js` (runs in CI) fails if they disagree or if any code file hardcodes the URL.

3. **[infra] Host the viewer stack** behind the live URL (nginx + api + martin) with `infra/docker-compose.prod.yml`:
   ```bash
   APP_VERSION=$(git describe --tags --abbrev=0 | sed 's/^v//') docker compose -f infra/docker-compose.prod.yml --env-file .env up --build -d
   ```
   If you host nginx some other way, use `infra/nginx.viewer.conf` plus `infra/nginx/map-buddy-api.prod.conf` (mounted at `/etc/nginx/pv/map-buddy-api.conf`), or replicate everything under "nginx" below — the rate limits, security headers and private-file blocks live there. **Never** mount the `.dev.conf` snippet in production: it proxies `/map-buddy-api/` to a local Map Buddy (the smoke test fails if that route answers).
   - Each service gets **only its own settings** (compose `environment:` lists, not `env_file`): `api` never sees the Anthropic key or Martin's login, `martin` sees only `MARTIN_DATABASE_URL`. A new setting must be added to the service's list to take effect.
   - **Caching:** there is **no content-hash build** (scripts load by literal paths). The config sends `Cache-Control: no-store` on `/demo/`, `/admin/`, `/frontend/public/`, `/engine/` and `/map-buddy/js|css/`. Keep that for the testing window, or front with a CDN that cache-busts (DIC-1863 Q7).
   - **Rebuild `api`** from `backend/` — it's a baked image and much of the hardening is in it.

4. **[verify] Database.** `api` + `martin` must reach the shared Cloud SQL PostGIS from the prod host. Restart `martin` after deploy so it discovers the `geo.*_tiles` functions.
   - **Connection budget:** each `api` worker holds up to `PV_POOL_MAX` (10) read connections plus up to 4 config-store connections, so ~28 at the default 2 workers; `martin` adds up to 8 (`pool_size` in `infra/martin/martin.yaml`; Martin's own default is 20). That's **~36 at peak** from one viewer stack. Check it against the instance's `max_connections` and everything else that shares it (DIC-1863 Q5; PgBouncer is DIC-316). Lower `PV_POOL_MAX` or `UVICORN_WORKERS` if it doesn't fit.
   - **Admin config store (optional):** if `PV_WRITER_DATABASE_URL` is set, apply `backend/migrations/0001_config_store.sql` first (creates schema `config` + role `pv_writer`), then `0002_config_versions_unique_version.sql` (one row per published version, so simultaneous publishes get a 409 rather than a duplicate; DIC-1872). The `pv_writer` bug where the store never initialized (no `CREATE` on schema `config`) is fixed (#17).

5. **[decide] Tenant isolation (RLS).** Single-tenant VBC (current) → migration 015 can wait. Multi-tenant → apply `county-data-services/migrations/015_tenant_isolation_rls.sql` and set `app.current_tenant` per request.

6. **[verify] Run the smoke test** (below). Exit code 0 = ready.

---

## Settings changed by the pre-launch hardening (2026-09-25, PRs #16–#21)

### Viewer `api` (env)

| Variable | Default | Prod guidance |
|---|---|---|
| `UVICORN_WORKERS` | `2` | Worker processes. Size with the DB connection budget (step 4). |
| `PV_POOL_MAX` / `PV_POOL_TIMEOUT_S` | `10` / `10` | Read pool per worker; waiting longer than the timeout for a connection → 503. |
| `PV_STATEMENT_TIMEOUT_MS` | `10000` | Server-side cap on any one query (read + config pools) → 503. |
| `PV_CORS_ORIGINS` | `https://gis.dicemi.org` | Set to the real origin(s) at launch (`https://gis.vanburencountymi.gov`). The viewer itself is same-origin via `/api/`. |
| `REPORT_ERROR_RATE_LIMIT` / `REPORT_ERROR_GLOBAL_LIMIT` | `5/hour` / `100/day` | `/report-error` emails the county GIS inbox; per-IP and overall caps. |
| `PV_API_DOCS` | unset (off) | **Leave unset in prod.** `1` re-enables `/docs` + `/openapi.json` (the dev compose sets it). |
| `PV_WRITER_DATABASE_URL` / `PV_ADMIN_TOKEN` | unset | Admin config writes and admin layer discovery. No token → 401; no store → 503 (safe defaults). |
| `PV_DB_CONNECT_TIMEOUT_S` / `PV_DB_TCP_USER_TIMEOUT_MS` | `5` / `10000` | Read pool: a dead DB connection fails in ~10s (then 503, and the pool recovers) instead of hanging (DIC-1872). |
| `PV_WRITER_POOL_TIMEOUT_S` / `PV_WRITER_CONNECT_TIMEOUT_S` | `3` / `3` | Config store: the public `/config.js` path gives up on the writer DB within seconds. |
| `PV_CONFIG_STORE_RETRY_S` | `30` | After a writer-DB failure, serve the baked manifest (and 503 admin writes) without retrying for this long. |
| `PV_DISCOVERY_CACHE_S` | `60` | Admin layer discovery (a `count(*)` per geo table) is cached this long. |
| `PV_SMTP_HOST` / `PV_SMTP_PORT` / `PV_SMTP_USER` / `PV_SMTP_PASSWORD` / `PV_SMTP_STARTTLS` | unset / `587` / unset / unset / `true` | Mail for "Report a problem". **No host → `/report-error` answers 503** (the button fails). |
| `PV_REPORT_TO` / `PV_REPORT_FROM` | `gis@vanburencountymi.gov` / the SMTP user | Where problem reports go, and the sender. |
| `WMS_PROXY_RATE_LIMIT` / `WMS_PROXY_MAX_BYTES` | `45/minute` / `5242880` | Per-IP cap on `/api/wms-proxy` (federal flood/wetland maps), and the largest image it relays. |
| `CLIENT_ERROR_RATE_LIMIT` / `CLIENT_ERROR_GLOBAL_LIMIT` | `20/minute` / `5000/day` | Browser error beacon (`/api/client-errors`; DIC-1879). |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` / `SENTRY_TRACES_SAMPLE_RATE` | unset / unset / `0` | Error reporting (ADR 0001). No DSN → errors go to the logs only. |
| `LOG_LEVEL` / `LOG_FORMAT` | `INFO` / `json` (image default) | The dev compose sets `LOG_FORMAT=text`. |

### nginx (`infra/nginx.viewer.conf`)

- **Rate limits on `/api/`**, per client IP: 20 req/s (burst 60) overall, plus 5 req/s (burst 30) on `/api/parcels`, `/api/cohort`, `/api/search`. **`/tiles/` and `/aerial/`**: 60 req/s each (burst 300), sized so fast panning never trips them but a scraper does (DIC-1871). Excess → 429.
- **`/aerial/` only relays tile paths** (`/aerial/{z}/{y}/{x}`); anything else is a 404, and the cache key is the tile, so query strings can't fill the cache.
- **`/map-buddy-api/`** comes from an include: 404 in production (`infra/nginx/map-buddy-api.prod.conf`), a proxy to the local container in dev (`…dev.conf`).
- `/` redirects to `/demo/` with a relative `Location` (correct behind any proxy or port). `*.md` files and `/engine/test/` are a 404.
  ⚠ Keys on `$binary_remote_addr`. If a load balancer / CDN sits in front of nginx, configure `set_real_ip_from` + `real_ip_header` for it first, or every user shares one bucket (DIC-1863 Q2).
- **Security headers:** `X-Content-Type-Options: nosniff` everywhere; `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN` and a **report-only** `Content-Security-Policy` on the viewer and admin pages. The CSP string is defined once in the `map $host $pv_csp` block. Switch it to enforced once testers report a clean console. **HSTS** goes wherever TLS terminates (DIC-1863 Q3).
  ⚠ nginx drops server-level `add_header`s in any location that sets its own — if you add a location with `add_header`, repeat the security headers there.
- **Private files:** only `/map-buddy/js/` and `/map-buddy/css/` are served (everything else under `/map-buddy/` is a 404), and dotfiles (`.env`, `.git`) are a 404 from every static root.
- **Admin console:** `/admin/` is publicly reachable until real auth ([DIC-463](https://linear.app/dicelabs/issue/DIC-463)). Gate it with basic auth or an IP allowlist (DIC-1863 Q4). Writes already require `PV_ADMIN_TOKEN`.

### Map Buddy (Cloud Run env — set by `deploy.sh`)

| Variable | `deploy.sh` value | Notes |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://gis.dicemi.org` (`VIEWER_ORIGINS`) | No localhost in prod. Must include the live viewer origin or AI fails in the browser. |
| `PARCEL_API_BASE` | `https://gis.dicemi.org/api` | The agent's parcel lookups; override at launch. |
| `MAP_BUDDY_TENANT` | `vanburen` | Quota + cache tenant; no longer read from requests. |
| `AI_QUOTA_DEFAULT` / `AI_QUOTA_WINDOW` | `200` / `86400` | 200 AI calls per rolling 24h. ⚠ **Not a hard ceiling** until DIC-1862: each instance counts separately, and an instance that scales to zero and restarts starts again at 0. The Anthropic spend limit is the real backstop. `AI_QUOTA_OVERRIDES` sets per-tenant limits. |
| `--max-instances` / `--concurrency` / `--timeout` | `3` / `20` / `300` | `MAX_INSTANCES`, `CONCURRENCY`, `REQUEST_TIMEOUT` in `deploy.sh`. |
| `MAP_BUDDY_API_DOCS` | unset (off) | **Leave unset in prod.** |
| `ANTHROPIC_TIMEOUT_S` / `ANTHROPIC_MAX_RETRIES` | `60` / `1` (code defaults) | |
| `MAP_BUDDY_MAX_BODY_BYTES`, `MAP_BUDDY_MAX_MESSAGE_CHARS`, `MAP_BUDDY_MAX_HISTORY` | `65536`, `2000`, `12` (code defaults) | Request caps; over-size → 413 / 422 before any model call. |
| `MAP_BUDDY_MODEL` / `EXPLAIN_MODEL` / `JUDGE_MODEL` / `AUTOCONFIGURE_MODEL` | `claude-sonnet-4-6` / chat model / `claude-haiku-4-5` / `claude-haiku-4-5` (code defaults) | Model per route. `*_MAX_TOKENS` cap each response (chat: `2048`); `MAP_BUDDY_MAX_ITERS` (`6`) caps tool steps per chat turn. |
| `MAP_BUDDY_RATE_LIMIT` and per-route `*_RATE_LIMIT` | `120/minute`; explain / describe-cohort / judge / autoconfigure `60/minute` | Per-IP. ⚠ Behind Cloud Run every caller may share one IP (DIC-1854). |
| `AI_RESULT_CACHE` / `AI_CACHE_MAX` / `AI_CACHE_TTL` | `1` / `256` / `3600` | Identical explainer requests are served from memory (no model call) for an hour. |
| `KB_BACKEND` / `KB_FIXTURE` / `KB_JURISDICTION` / `KB_DATABASE_URL` | `fixture` / bundled JSON / `vanburen` / unset | Citation source. `KB_BACKEND=dice` reads the real `knowledge.chunks` and needs `KB_DATABASE_URL`. |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` | unset | Set once in the Cloud Run console; `deploy.sh` leaves them alone. |

Still open in [DIC-1854](https://linear.app/dicelabs/issue/DIC-1854) (waiting on DIC-1862): shared quota store, real client IP behind Cloud Run, and locking down `/judge` + `/autoconfigure` (still public).

---

## Post-deploy smoke test [verify]

**Automated** — run from any machine with bash + curl (Linux, macOS, Git Bash):

```bash
bash infra/smoke-test.sh https://gis.dicemi.org
bash infra/smoke-test.sh https://gis.dicemi.org --rate-limit        # also checks nginx throttling (throttles your IP for a few seconds)
```

It checks routes + DB reachability, security headers, private files and API docs → 404, the dev-only `/map-buddy-api/` proxy is off, bad input → 400/422, CORS, and Map Buddy (URL read from `/api/config.js`, or `--map-buddy <url>`): key present, quota **on**, docs hidden, viewer origin allowed, request caps. It never calls the model — the chat probes only run once the hardened build is confirmed, so an old build can't be billed. `PASS` / `WARN` / `FAIL` per check; **exit 1 on any FAIL**. Expected `WARN`s until the open decisions land: report-only CSP, no HSTS, admin writes disabled (503).

**Manual** (needs a browser and costs a few AI calls):
- Load the URL → a parcel selects, popup renders (Parcel / Owner / Assessed Values + AV chart), labels follow pan.
- Open an explainer (Assessment) → AI narration arrives (proves Cloud Run + key + viewer → Map Buddy URL).
- Open Neighborhood Profile → dashboard + environmental + AI "character" read (proves `/cohort` + `/describe-cohort`).
- Toggle dark mode; the browser console is clean — in particular **no `[Report Only]` CSP messages** (if there are, fix the CSP before enforcing it).

## Known gotchas (already handled in-repo)
- `/demo/`, `/admin/`, `/frontend/public/`, `/engine/`, `/map-buddy/js|css/` send `no-store` (stale JS/HTML otherwise).
- AI-availability uses hysteresis (no premature "unavailable" toast on a single cold-start blip).
- Map fails to load → an in-map "The map couldn't load" card with Try again; search failures show a message (#21).
- CI (`harness`) runs on every PR and every push to `main` (#20).

## What deploy does NOT unblock
The keystone's last mile is **dev-environment**, not deployment: A3 contract-globals (needs parcel-studio runnable) and ZIP-as-a-theme (needs ZIP runnable + Lockport data migrated). A live URL helps testing, not these. See `engine/THEME_RENDERING_ACID_TEST.md`.
