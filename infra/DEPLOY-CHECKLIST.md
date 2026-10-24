# Parcel Viewer — deploy-readiness checklist

Target: a live URL for testing at `gis.dicemi.org` during the parallel rollout, moving to
`gis.vanburencountymi.gov` at launch (county IT does the DNS; see
[DIC-1863](https://linear.app/dicelabs/issue/DIC-1863) Q1). The code defaults use `gis.dicemi.org`. Plan and status:
[DIC-1851 Pre-launch hardening](https://linear.app/dicelabs/issue/DIC-1851).

Two deployables:
- **Viewer** — nginx + `django-api` (the Django API, the first deployed backend; DIC-2150) with its own `django-db`, + `martin` (tiles). **Production: `infra/docker-compose.prod.yml`** + `infra/nginx.viewer.conf`. `infra/docker-compose.viewer.yml` is the local dev stack (adds a local Map Buddy, API docs and readable logs); don't deploy it.
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
   - `api/county_config/baked/vanburen.json` (served as `/api/config.js` when the config store is empty or down; the `django-api` image is baked, **rebuild it** if changed)
   - `engine/themes/vanburen.json` (`endpoints.mapBuddy` and `mapBuddy.apiBase`)

   Today they read `https://map-buddy-toaozre74a-uc.a.run.app`. If the URL changes, update all three; `engine/test/endpoints.test.js` (runs in CI) fails if they disagree or if any code file hardcodes the URL.

3. **[infra] Host the viewer stack** behind the live URL (nginx + Django API + martin) with `infra/docker-compose.prod.yml`. First set the three settings it requires in `.env` (compose refuses to start without them): `DJANGO_SECRET_KEY`, `DJANGO_DB_PASSWORD` and `PV_PUBLIC_HOST` (see "Django API" below). Then:
   ```bash
   APP_VERSION=$(git describe --tags --abbrev=0 | sed 's/^v//') docker compose -f infra/docker-compose.prod.yml --env-file .env up --build -d
   ```
   If you host nginx some other way, use `infra/nginx.viewer.conf` plus `infra/nginx/map-buddy-api.prod.conf` (mounted at `/etc/nginx/pv/map-buddy-api.conf`), or replicate everything under "nginx" below — the rate limits, security headers and private-file blocks live there. **Never** mount the `.dev.conf` snippet in production: it proxies `/map-buddy-api/` to a local Map Buddy (the smoke test fails if that route answers).
   - **Start-up order:** `django-db` (healthy) → `django-migrate` (applies Django's migrations, then exits) → `django-api` (healthy on `/health`) → `web`. A failed migration stops the deploy before anything is served.
   - Each service gets **only its own settings** (compose `environment:` lists, not `env_file`): the Django API never sees the Anthropic key or Martin's login, and `martin` sees only `MARTIN_DATABASE_URL`. A new setting must be added to the service's list to take effect (for Django, the shared `x-django-environment` block).
   - **The `web` service is a built image** (`infra/web.Dockerfile`, DIC-2180): `--build` runs the Vite build in a Node stage and copies the pages, the hashed CSS (`/assets/`) and the script/engine/Map Buddy folders into nginx. The host needs Docker only. Only nginx's config and its two per-environment includes are mounted.
   - **Caching:** `/assets/` files are content-hashed and sent with a one-year `immutable` cache. The pages and the scripts still load by literal paths (bundling them is DIC-2180 slice 2b), so `/demo/`, `/admin/`, `/frontend/public/`, `/engine/` and `/map-buddy/js|css/` keep `Cache-Control: no-store` for now.
   - **`--build` rebuilds the Django image** (`api/`, target `production`: gunicorn, with the admin's static files collected at build). It's a baked image, config included.
   - **TLS** ends at the proxy in front of nginx (DIC-1863 Q3). That proxy must send `X-Forwarded-Proto: https`; nginx passes it on to Django, which otherwise redirects every API call to HTTPS (and would loop). Django's own redirect stays on as a backstop (`SECURE_SSL_REDIRECT=1`); set `0` only for a deployment served over plain HTTP.
   - **First staff account** (signs in to the Admin Console, and to the Django admin at `/api/django-admin/`):
     ```bash
     docker compose -f infra/docker-compose.prod.yml --env-file .env exec django-api python manage.py createsuperuser
     ```
     Then, in the Django admin, give each staff user the counties they may edit (County access). Further staff accounts can be made there.
   - **Load the county's FEMA flood zones** (DIC-2412). Map clicks, the Neighborhood Profile and Map Buddy read flood from the API's own copy, and fall back to FEMA's slow service until it's loaded. Van Buren County's FEMA map id is `26159C`. This fetches from FEMA, so it needs outbound HTTPS:
     ```bash
     docker compose -f infra/docker-compose.prod.yml --env-file .env exec django-api python manage.py load_flood_zones --dfirm 26159C
     ```
     Run it again after a FEMA map revision; checking monthly is enough. Each load replaces the zones in one transaction and records its effective date (`/api/environment` reports it).
   - **Back up `django-db`** (staff accounts, sign-in tokens, data-access counters and the loaded flood zones; the parcel data is elsewhere):
     ```bash
     docker compose -f infra/docker-compose.prod.yml --env-file .env exec -T django-db pg_dump -U django parcel_viewer_api > django-db-$(date +%F).sql
     ```
     The data lives in the `django_db_data` volume: `docker compose down` keeps it, `down -v` deletes it.

4. **[verify] Database.** `django-api` + `martin` must reach the shared Cloud SQL PostGIS from the prod host. Restart `martin` after deploy so it discovers the `geo.*_tiles` functions.
   - **Connection budget (DIC-1884).** `infra/docker-compose.prod.yml` defaults to the stopgap until PgBouncer (DIC-316): **1 gunicorn worker (4 threads) with a read pool of 4**, plus up to 4 config-store connections (only when `PV_WRITER_DATABASE_URL` points at db-dice), plus Martin's 8 (`pool_size` in `infra/martin/martin.yaml`) = **at most 16** of the 17 this checklist allows. (The measurements below, from before DIC-2150, were of the FastAPI backend with a read pool of 5.)
     - *Measured* during a full e2e run against the production stack (2026-09-26): the viewer peaked at **14** (API 6, Martin 8; the config store wasn't enabled). One API worker kept up: the suite took 23.9 min against 23.5 min with 2 workers.
     - *The database:* db-dice's `max_connections` is **50** (3 reserved for superusers), not the 25 noted in June. Other clients held up to 16 at their separate peaks (10 `postgres` sessions; 6 untagged `parcel_studio_app`, probably parcel-studio, which shares the viewer's role). Everything together peaked at **27**.
     - The old defaults (2 workers × (10 + 4) + 8 = 36) could exhaust it alongside those, which is why they're no longer the production default. Raise `GUNICORN_WORKERS` / `DB_POOL_MAX` only when the budget allows: every worker has its own pools.
     - *Counting:* the Django API's connections are named in `pg_stat_activity` (`application_name` = `parcel-viewer-django`; the retired FastAPI backend's were `parcel-viewer-api` / `parcel-viewer-config`), so `SELECT application_name, count(*) FROM pg_stat_activity GROUP BY 1` shows the viewer's share.
   - **Admin config store:** without `PV_WRITER_DATABASE_URL`, it lives in `django-db`, which creates its tables on first start. To keep it on db-dice instead, set `PV_WRITER_DATABASE_URL` and apply `api/county_config/sql/0001_config_store.sql` first (creates schema `config` + role `pv_writer`), then `0002_config_versions_unique_version.sql` (one row per published version, so simultaneous publishes get a 409 rather than a duplicate; DIC-1872). The `pv_writer` bug where the store never initialized (no `CREATE` on schema `config`) is fixed (#17).

5. **[decide] Tenant isolation (RLS).** Single-tenant VBC (current) → migration 015 can wait. Multi-tenant → apply `county-data-services/migrations/015_tenant_isolation_rls.sql` and set `app.current_tenant` per request.

6. **[verify] Run the smoke test** (below). Exit code 0 = ready.

---

## Settings changed by the pre-launch hardening (2026-09-25, PRs #16–#21)

### Django API (`django-api`, production; DIC-2150)

Set in `.env`; compose passes them through the `x-django-environment` block of `infra/docker-compose.prod.yml`.

| Variable | Default | Prod guidance |
|---|---|---|
| `DJANGO_SECRET_KEY` | **required** | A long random string (`python -c "import secrets; print(secrets.token_urlsafe(48))"`). Signs sessions and tokens; never reuse the dev one. |
| `DJANGO_DB_PASSWORD` | **required** | Password for Django's own database (`django-db`). Set it before the first start: the volume is created with it. |
| `PV_PUBLIC_HOST` | **required** | The public host name, e.g. `gis.vanburencountymi.gov` (no scheme). Becomes `ALLOWED_HOSTS` and the trusted origin `https://<host>` for the Django admin's forms. |
| `GUNICORN_WORKERS` / `GUNICORN_THREADS` / `DB_POOL_MAX` | `1` / `4` / `4` | Size with the DB connection budget (step 4): every worker has its own pools. |
| `SECURE_SSL_REDIRECT` | `1` | Django's HTTPS backstop behind the TLS proxy. `0` only when serving over plain HTTP. |
| `SECURE_HSTS_SECONDS` | `0` | HSTS from Django; normally set where TLS terminates instead (DIC-1863 Q3). |
| `PV_ACCESS_MODE` / `PV_DETAIL_BUDGET` / `PV_SERVICE_KEYS` | per county / `5000` / unset | Data access for counties that sell data (ADR 0015). |
| `PV_TRUSTED_PROXY_HOPS` | `0` | Leave at `0` on the VM: the client address is nginx's `X-Real-IP`. On Cloud Run, the proxies that append to `X-Forwarded-For`: `2` behind the load balancer, `1` without (ADR 0018). Also read by the web image. |
| `LOG_FORMAT` | `json` | Set by the compose file. |

The rest are below ("Shared API settings"). Staff sign in with accounts (DIC-2151); there is no shared admin key.

### Shared API settings

`PV_DATABASE_URL` (read role), `PV_WRITER_DATABASE_URL` (config store; see step 4), `PV_CORS_ORIGINS`
(set to the real origin(s) at launch), mail (`PV_SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` /
`_STARTTLS`, `PV_REPORT_TO` / `_FROM`; **no host → `/report-error` answers 503**), limits
(`REPORT_ERROR_RATE_LIMIT` / `_GLOBAL_LIMIT` `5/hour` / `100/day`, `CLIENT_ERROR_RATE_LIMIT` /
`_GLOBAL_LIMIT` `20/minute` / `5000/day`, `WMS_PROXY_RATE_LIMIT` / `WMS_PROXY_MAX_BYTES` `45/minute` /
5 MB), `PV_CONFIG_STORE_RETRY_S` (`30`), `PV_DISCOVERY_CACHE_S` (`60`), Sentry (`SENTRY_DSN` /
`_ENVIRONMENT` / `_TRACES_SAMPLE_RATE`; no DSN → logs only) and `LOG_LEVEL`.

### nginx (`infra/nginx.viewer.conf`)

- **Rate limits on `/api/`**, per client IP: 20 req/s (burst 60) overall, plus 5 req/s (burst 30) on `/api/parcels`, `/api/cohort`, `/api/search`. **`/tiles/` and `/aerial/`**: 60 req/s each (burst 300), sized so fast panning never trips them but a scraper does (DIC-1871). Excess → 429.
- **`/aerial/` only relays tile paths** (`/aerial/{z}/{y}/{x}`); anything else is a 404, and the cache key is the tile, so query strings can't fill the cache.
- **`/map-buddy-api/`** comes from an include: 404 in production (`infra/nginx/map-buddy-api.prod.conf`), a proxy to the local container in dev (`…dev.conf`).
- `/` redirects to `/demo/` with a relative `Location` (correct behind any proxy or port). `*.md` files and `/engine/test/` are a 404.
  ⚠ Keys on `$pv_client_ip`: the socket peer on the VM. Behind Cloud Run or a load balancer, set `PV_TRUSTED_PROXY_HOPS` on the web image (ADR 0018), or every user shares one bucket.
- **Security headers:** `X-Content-Type-Options: nosniff` everywhere; `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN` and a **report-only** `Content-Security-Policy` on the viewer and admin pages. The CSP string is defined once in the `map $host $pv_csp` block; violations post to `/api/csp-report` and show in the API's logs (`parcel_viewer.routers.csp_reports`). Switch it to enforced (the header name in the three `add_header` lines) once the testing window's logs are clean. **HSTS** goes wherever TLS terminates (DIC-1863 Q3).
  ⚠ nginx drops server-level `add_header`s in any location that sets its own — if you add a location with `add_header`, repeat the security headers there.
- **Private files:** only `/map-buddy/js/` and `/map-buddy/css/` are served (everything else under `/map-buddy/` is a 404), and dotfiles (`.env`, `.git`) are a 404 from every static root.
- **Admin console:** `/admin/` is publicly reachable until real auth ([DIC-463](https://linear.app/dicelabs/issue/DIC-463)). Gate it with basic auth or an IP allowlist (DIC-1863 Q4). Writes already require a staff sign-in with access to the county.

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

## Rehearse locally before a deploy [verify]

Run the **production** stack on your machine first. It's the same compose file, nginx
snippet and images as the VM, and catches configuration mistakes before they reach it.
First done 2026-09-26 (DIC-1884): smoke test 48/48 and the full e2e suite (181 passed)
against it.

```bash
# 1. The production stack on a spare port (stop the dev stack's django-api and martin first:
#    both stacks share db-dice's connections).
PV_HTTP_PORT=8090 APP_VERSION=0.0.0-rehearsal \
  docker compose -p pv-rehearsal -f infra/docker-compose.prod.yml --env-file .env up --build -d

# 2. Map Buddy on its own origin, as Cloud Run is (the production nginx has no
#    /map-buddy-api/ proxy). Reads MAP_BUDDY_ANTHROPIC_API_KEY from .env.
docker build -t pv-rehearsal-mb map-buddy/backend
(set -a; . ./.env; set +a; docker run -d --name pv-rehearsal-mb --network pv-rehearsal_default \
  -p 127.0.0.1:8095:8000 -e ANTHROPIC_API_KEY="$MAP_BUDDY_ANTHROPIC_API_KEY" \
  -e ALLOWED_ORIGINS=http://127.0.0.1:8090 -e PARCEL_API_BASE=http://django-api:8000 \
  -e MAP_BUDDY_TENANT=vanburen -e AI_QUOTA_DEFAULT=200 -e AI_QUOTA_WINDOW=86400 pv-rehearsal-mb)

# 3. Check it.
bash infra/smoke-test.sh http://127.0.0.1:8090 --map-buddy http://127.0.0.1:8095
cd e2e && E2E_BASE_URL=http://127.0.0.1:8090 E2E_MAP_BUDDY_API=http://127.0.0.1:8095 npx playwright test

# 4. Tear down.
docker rm -f pv-rehearsal-mb && docker compose -p pv-rehearsal -f infra/docker-compose.prod.yml down
```

Expected: the smoke test's only warnings are report-only CSP and "not HTTPS"; e2e all
green (2 paid-AI tests skip). The API's logs are JSON lines, and it runs 1 worker.

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
- Toggle dark mode; the browser console is clean — in particular **no `[Report Only]` CSP messages** and no `csp_reports` warnings in the API logs (if there are, fix the page or the CSP before enforcing it).

## Known gotchas (already handled in-repo)
- **Assessed-value year labels** follow the roll year the API infers from `assessing.vbc_parcels.loaded_at` (loaded April onward = that year's roll; January–March = the previous roll), so they change when the data is refreshed, not on January 1. If a load doesn't fit that rule, set `assessing.rollYear` in the county config (DIC-1878).
- `/demo/`, `/admin/`, `/frontend/public/`, `/engine/`, `/map-buddy/js|css/` send `no-store` (stale JS/HTML otherwise).
- AI-availability uses hysteresis (no premature "unavailable" toast on a single cold-start blip).
- Map fails to load → an in-map "The map couldn't load" card with Try again; search failures show a message (#21).
- CI (`harness`) runs on every PR and every push to `main` (#20).

## What deploy does NOT unblock
The keystone's last mile is **dev-environment**, not deployment: A3 contract-globals (needs parcel-studio runnable) and ZIP-as-a-theme (needs ZIP runnable + Lockport data migrated). A live URL helps testing, not these. See `engine/THEME_RENDERING_ACID_TEST.md`.
