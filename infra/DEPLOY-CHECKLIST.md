# Parcel Viewer — deploy-readiness checklist

Target: a live URL for testing, likely `parcels.dicemi.org` (hostname to be confirmed in
[DIC-1863](https://linear.app/dicelabs/issue/DIC-1863) Q1). Plan and status:
[DIC-1851 Pre-launch hardening](https://linear.app/dicelabs/issue/DIC-1851).

Two deployables:
- **Viewer** — nginx + `api` (FastAPI) + `martin` (tiles). Defined in `infra/docker-compose.viewer.yml` / `infra/nginx.viewer.conf`.
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
   - `deploy.sh` now sets `PARCEL_API_BASE`, `MAP_BUDDY_TENANT`, `AI_QUOTA_DEFAULT` / `AI_QUOTA_WINDOW`, and prod-only `ALLOWED_ORIGINS` (no localhost). Override any of them via the environment when running it, e.g. `PARCEL_API_BASE=https://<host>/api bash map-buddy/deploy.sh`.
   - Key comes from secret `MAP_BUDDY_ANTHROPIC_API_KEY` (already wired).
   - ⚠ **Cold starts:** `--min-instances 0`. The first AI call cold-starts (~seconds). Health-check hysteresis hides a single blip; for the testing window consider `--min-instances 1` (DIC-1862 Q5).

2. **[verify] Viewer points at the deployed Map Buddy URL.** `deploy.sh` prints the Cloud Run URL. It lives in **config only**, in three files, and every browser module resolves it through `frontend/public/js/pv-endpoints.js`:
   - `frontend/public/js/county-config.js` (`endpoints.mapBuddy`)
   - `backend/parcel_viewer/county_configs/vanburen.json` (served as `/api/config.js`; the `api` image is baked, **rebuild it** if changed)
   - `engine/themes/vanburen.json` (`endpoints.mapBuddy` and `mapBuddy.apiBase`)

   Today they read `https://map-buddy-toaozre74a-uc.a.run.app`. If the URL changes, update all three; `engine/test/endpoints.test.js` (runs in CI) fails if they disagree or if any code file hardcodes the URL.

3. **[infra] Host the viewer stack** behind the live URL (nginx + api + martin). Use `infra/nginx.viewer.conf` as the nginx config, or replicate everything under "nginx" below — the rate limits, security headers and private-file blocks live there.
   - **Caching:** there is **no content-hash build** (scripts load by literal paths). The config sends `Cache-Control: no-store` on `/demo/`, `/admin/`, `/frontend/public/`, `/engine/` and `/map-buddy/js|css/`. Keep that for the testing window, or front with a CDN that cache-busts (DIC-1863 Q7).
   - **Rebuild `api`** from `backend/` — it's a baked image and much of the hardening is in it.

4. **[verify] Database.** `api` + `martin` must reach the shared Cloud SQL PostGIS from the prod host. Restart `martin` after deploy so it discovers the `geo.*_tiles` functions.
   - **Connection budget:** each `api` worker holds up to `PV_POOL_MAX` (10) read connections plus up to 4 config-store connections. At the default 2 workers that's ~28 per `api` instance at peak — check against the instance's `max_connections` (DIC-1863 Q5).
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
| `PV_CORS_ORIGINS` | `https://parcels.dicemi.org,https://map.dicemi.org` | Set to the real origin(s) if the hostname differs. The viewer itself is same-origin via `/api/`. |
| `REPORT_ERROR_RATE_LIMIT` / `REPORT_ERROR_GLOBAL_LIMIT` | `5/hour` / `100/day` | `/report-error` emails the county GIS inbox; per-IP and overall caps. |
| `PV_API_DOCS` | unset (off) | **Leave unset in prod.** `1` re-enables `/docs` + `/openapi.json` (the dev compose sets it). |
| `PV_WRITER_DATABASE_URL` / `PV_ADMIN_TOKEN` | unset | Admin config writes and admin layer discovery. No token → 401; no store → 503 (safe defaults). |
| `PV_DB_CONNECT_TIMEOUT_S` / `PV_DB_TCP_USER_TIMEOUT_MS` | `5` / `10000` | Read pool: a dead DB connection fails in ~10s (then 503, and the pool recovers) instead of hanging (DIC-1872). |
| `PV_WRITER_POOL_TIMEOUT_S` / `PV_WRITER_CONNECT_TIMEOUT_S` | `3` / `3` | Config store: the public `/config.js` path gives up on the writer DB within seconds. |
| `PV_CONFIG_STORE_RETRY_S` | `30` | After a writer-DB failure, serve the baked manifest (and 503 admin writes) without retrying for this long. |
| `PV_DISCOVERY_CACHE_S` | `60` | Admin layer discovery (a `count(*)` per geo table) is cached this long. |

### nginx (`infra/nginx.viewer.conf`)

- **Rate limits on `/api/`**, per client IP: 20 req/s (burst 60) overall, plus 5 req/s (burst 30) on `/api/parcels`, `/api/cohort`, `/api/search`. Excess → 429.
  ⚠ Keys on `$binary_remote_addr`. If a load balancer / CDN sits in front of nginx, configure `set_real_ip_from` + `real_ip_header` for it first, or every user shares one bucket (DIC-1863 Q2).
- **Security headers:** `X-Content-Type-Options: nosniff` everywhere; `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN` and a **report-only** `Content-Security-Policy` on the viewer and admin pages. The CSP string is defined once in the `map $host $pv_csp` block. Switch it to enforced once testers report a clean console. **HSTS** goes wherever TLS terminates (DIC-1863 Q3).
  ⚠ nginx drops server-level `add_header`s in any location that sets its own — if you add a location with `add_header`, repeat the security headers there.
- **Private files:** only `/map-buddy/js/` and `/map-buddy/css/` are served (everything else under `/map-buddy/` is a 404), and dotfiles (`.env`, `.git`) are a 404 from every static root.
- **Admin console:** `/admin/` is publicly reachable until real auth ([DIC-463](https://linear.app/dicelabs/issue/DIC-463)). Gate it with basic auth or an IP allowlist (DIC-1863 Q4). Writes already require `PV_ADMIN_TOKEN`.

### Map Buddy (Cloud Run env — set by `deploy.sh`)

| Variable | `deploy.sh` value | Notes |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://map.dicemi.org,https://parcels.dicemi.org` | No localhost in prod. Must include the live viewer origin or AI fails in the browser. |
| `PARCEL_API_BASE` | `https://parcels.dicemi.org/api` | The agent's parcel lookups; override if the hostname differs. |
| `MAP_BUDDY_TENANT` | `vanburen` | Quota + cache tenant; no longer read from requests. |
| `AI_QUOTA_DEFAULT` / `AI_QUOTA_WINDOW` | `200` / `86400` | 200 AI calls per rolling 24h. ⚠ In memory **per instance** until DIC-1862, so up to 3 × 200/day at `--max-instances 3`. |
| `MAP_BUDDY_API_DOCS` | unset (off) | **Leave unset in prod.** |
| `ANTHROPIC_TIMEOUT_S` / `ANTHROPIC_MAX_RETRIES` | `60` / `1` (code defaults) | |
| `MAP_BUDDY_MAX_BODY_BYTES`, `MAP_BUDDY_MAX_MESSAGE_CHARS`, `MAP_BUDDY_MAX_HISTORY` | `65536`, `2000`, `12` (code defaults) | Request caps; over-size → 413 / 422 before any model call. |

Still open in [DIC-1854](https://linear.app/dicelabs/issue/DIC-1854) (waiting on DIC-1862): shared quota store, real client IP behind Cloud Run, and locking down `/judge` + `/autoconfigure` (still public).

---

## Post-deploy smoke test [verify]

**Automated** — run from any machine with bash + curl (Linux, macOS, Git Bash):

```bash
bash infra/smoke-test.sh https://parcels.dicemi.org
bash infra/smoke-test.sh https://parcels.dicemi.org --rate-limit    # also checks nginx throttling (throttles your IP for a few seconds)
```

It checks routes + DB reachability, security headers, private files and API docs → 404, bad input → 400/422, CORS, and Map Buddy (URL read from `/api/config.js`, or `--map-buddy <url>`): key present, quota **on**, docs hidden, viewer origin allowed, request caps. It never calls the model — the chat probes only run once the hardened build is confirmed, so an old build can't be billed. `PASS` / `WARN` / `FAIL` per check; **exit 1 on any FAIL**. Expected `WARN`s until the open decisions land: report-only CSP, no HSTS, admin writes disabled (503).

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
