# 18. Cloud Run hosting: Cloudflare in front of one Cloud Run service

## Status

Proposed (DIC-2554). Answers readiness blocker B9 (`docs/READINESS-CHECKLIST.md`). Nothing here has been deployed or priced in a console.

**Revised 2026-10-30.** The first version (2026-10-23) put a Google load balancer with Cloud Armor in front of three Cloud Run services. Maria's review on DIC-1863 (2026-10-29) called that overkill, and asked us to follow the team's standard deployment instead: Cloudflare in front of Cloud Run, as `dice-document-pipeline-api` does. She also asked for app-level rate limiting, a look at Neon for the database, OpenTofu for staging and prod, Secret Manager and Sentry. This version does that. Choices that are still open are marked **[Maria]**: Drake is leaving, and the team's Cloudflare account and standards are hers.

**Revised 2026-11-04.** Maria's comment on #105 (2026-11-03): parcel data is moving out of db-dice into a private database owned by one Django/DRF service, `parcel-data-api` (Knox token auth). Every consumer, the viewer included, becomes a token-authenticated client of it. So the viewer and Martin no longer connect to db-dice: there is no parcel database URL, no Cloud SQL connector and no db-dice connection budget in this design. Where tiles come from (a Martin sidecar reading the new database, or the API itself) is still open on Maria's side, so this version leaves it open and holds the pieces that depend on it. The Cloudflare, Worker and origin-lock parts are unchanged. A second comment the same day asked for OpenTofu to follow `did-vaultwarden`'s model: a 24-hour bootstrap token that creates the other tokens, so each part's permissions are recorded in code (section 10). That model deploys from GitHub Actions through Workload Identity Federation, so this version picks GitHub Actions over Cloud Build.

## Context

On 2026-10-19 Maria recommended on DIC-1863 that the viewer run on **Cloud Run in its own GCP project**, not on the shared e2-small VM. The site is public and read-only, so rate limiting has to work both in the app and in front of it.

Everything in `infra/` was written for one VM running Docker Compose (`infra/docker-compose.prod.yml`):

| Piece | On the VM | What Cloud Run changes |
|---|---|---|
| `web` (nginx) | Static Vite bundle, security headers and CSP, `/api/` and `/tiles/` routing, gzip, the `/aerial/` proxy with a 1 GB disk cache, `limit_req` per IP | No shared disk (the filesystem is memory), no Docker DNS, the port comes from `$PORT`, and requests arrive through a proxy, so `$remote_addr` isn't the client |
| `django-api` | gunicorn, 1 worker × 4 threads, pools of 4; reads parcels from db-dice; reached only from nginx | Probes call the container directly; parcels come from `parcel-data-api`, not db-dice |
| `martin` | Tiles from db-dice, pool of 8 | Must not read db-dice; the tile source is open (section 7) |
| `django-db` | A Postgres container with a volume | No volumes: it needs a home |
| TLS | The host proxy or Certbot | Cloudflare |
| Secrets | `.env` on the host | Secret Manager |

**The team's standard** is in `dice-document-pipeline-api`, whose ADRs this one follows:
- Neon for the database (its ADR 0028), with a nightly backup to R2 (0039);
- per-IP limits in the app that read the real client address (0031, 0034);
- an origin lock, so Cloud Run's own `run.app` address can't be used to get around Cloudflare (0036);
- one OpenTofu module for staging and prod (0040);
- a Cloudflare Worker in front of Cloud Run (0041);
- Cloudflare's WAF and rate limiting (0042);
- Cloudflare Access for the admin (0043);
- Sentry (0017).

**Fixed points:**
- **DNS:** `dicemi.org` is in the team's Cloudflare account. `vanburencountymi.gov` is county IT's DNS (CJ Johnson), not Cloudflare. Source: Drake's "Where does DNS for ___ live?" Linear document, 2026-10-29.
- **Parcel data comes from `parcel-data-api`,** not db-dice (Maria, 2026-11-03). Parcel data moves out of db-dice into a private database owned by that one Django/DRF service, and every consumer calls it with a Knox token. The viewer's server-side code calls it with a service token that stays on the server; the browser never sees it. The viewer's public routes and ADR 0015's metering stay in the viewer. The API contract is being confirmed on Linear. For scale, the parcel data the viewer reads today is **272 MB** (measured in db-dice 2026-10-30; the biggest tables are `geo.parcel_geometry`, 50 MB, and `geo.address_points`, 37 MB).
- **Map Buddy** already runs on Cloud Run in `core-db-475718`.

**What makes the viewer unlike the pipeline:**
- **It's a map, so traffic is mostly tiles.** One pan or zoom asks for dozens of tiles, and a long session asks for hundreds. The pipeline gets a few API calls a day.
- **It has two or three processes, not one:** nginx and Django, plus Martin if tiles stay with a Martin sidecar (section 7). Martin is an upstream binary, so it can't check an origin-lock header itself.
- **Every page load reads Django's own database.** `/api/config.js` reads the published county config from the config store. Identify and Map Buddy read flood zones from it too (`/api/environment`, DIC-2414).

## Decision (proposed)

### 1. Shape: Cloudflare → a Worker → one Cloud Run service with nginx and Django

```
gis.dicemi.org ──> Cloudflare (TLS, managed WAF, rate-limit rule, Access on the admin)
                    └─ Worker: adds the origin secret, the client IP and the public host
                        └─ pv-viewer.run.app: one Cloud Run service
                            ├─ nginx   (ingress, $PORT): pages, headers, CSP, gzip, /aerial/,
                            │          limit_req, origin lock
                            ├─ django  (127.0.0.1:8000): /api/ ──> parcel-data-api (service token)
                            └─ /tiles/: open (section 7): a Martin sidecar on 127.0.0.1:3000
                                        reading parcel-data-api's database, or the API itself
```

- **One service, nginx plus sidecars.** Cloud Run runs an ingress container plus sidecars, which share `localhost`. This is the compose layout almost unchanged. nginx keeps every rule already tested: the headers and CSP, `/` → `/demo/`, the page fallbacks, the 404s for `.md`, dotfiles and `/map-buddy/`, gzip on the API's GeoJSON, and the `/aerial/` proxy. Only its upstreams change, from compose names to `127.0.0.1`.
- **Why one service:**
  - The Worker forwards everything to one `run.app` host, as the pipeline's Worker does.
  - The origin lock is checked once, in nginx, and so it covers `/tiles/` too. If Martin stays and ran as its own service, its `run.app` address would be open to anyone.
  - Nothing is proxied twice, and nginx doesn't have to call other services over HTTPS.
  - One warm instance (section 11) keeps every process warm.
- **The cost of one service:** the containers scale together, and an instance reserves the sum of their CPU and memory. At test traffic that's fine. If tiles ever need to scale apart from the API, Martin can move to its own service behind nginx later.
- **Startup order:** container dependencies start Django (and Martin, if kept) before nginx. Each container has its own startup probe. Django's probe uses `/health/live` (part 2).
- **Migrations** run as a Cloud Run job from the API image (`python manage.py migrate --noinput`) before a new revision takes traffic, as `django-migrate` does in compose.
- **Ingress is "all",** because the Worker reaches the service on its public `run.app` address. The origin lock (section 3) is what refuses everyone else.

Alternatives:
- **A Google load balancer with Cloud Armor** (this ADR's first version): about $30 a month more, tied to Google, and per Maria more than we need.
- **Three services, with the Worker routing by path:** this leaves Martin's `run.app` address open, because Martin can't check the secret.
- **Cloud Run domain mapping without Cloudflare:** a Preview feature, with no WAF or rate limiting in front.
- **Static files from a bucket:** it loses nginx's page fallbacks, 404 rules and per-path headers. Revisit when the classic pages are gone (ADR 0017).

### 2. The Worker

- **It follows the pipeline's Worker** (`deploy/terraform/prod/worker/index.js` there). It forwards the request to the `run.app` host, adds `X-Origin-Secret`, and puts the public hostname in `X-Forwarded-Host`.
- **It also sends the client's address** in a header of our own, `X-PV-Client-IP`, copied from `CF-Connecting-IP` on the incoming request. nginx trusts that header only when the secret matches (section 4). This doesn't depend on which address Cloudflare uses when a Worker calls an outside origin, which the pipeline still had to check on prod (its ADR 0041).
- **Workers Paid ($5 a month), not Free.** The Free plan stops at 100,000 requests a day, and then the site is down until midnight UTC. Tiles alone could reach that with a few hundred map sessions in a day. The paid plan includes 10 million requests a month.
- **Edge caching, to try on staging:** the Worker can let Cloudflare cache content-hashed `/assets/` for a long time and `/tiles/` for a short TTL. That takes load off Cloud Run and `parcel-data-api`. Admin and API responses are never cached. This isn't part of the first deploy.
- The Worker, its custom domain and its settings live in OpenTofu (section 10). The secret is set on the Worker by hand, so it stays out of OpenTofu's state, as in the pipeline.

### 3. Origin lock, in nginx

- **nginx checks the secret.** When `PV_ORIGIN_LOCK_SECRET` is set, any request whose `X-Origin-Secret` doesn't match gets a plain 403. That covers pages, `/api/`, `/tiles/` and `/aerial/`.
- **One exception:** Cloud Run's probes call the containers directly, without the header, so the probe path is exempt.
- **Django (and Martin, if kept) listen only on `127.0.0.1`,** so nothing reaches them except through nginx.
- **The public hostname:** nginx forwards a fixed public host to Django, from `PV_PUBLIC_HOST`, rather than the incoming `Host` (the `run.app` name). So `ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS` work unchanged, and Django never has to trust `X-Forwarded-Host`.
- **An empty secret switches the lock off.** That's the default, so the VM and local development are unaffected. The rollout order is the pipeline's: route through the Worker first, then turn the lock on.

### 4. The client IP

- **Through the Worker,** nginx takes the client from `X-PV-Client-IP`, but only on requests that carry the right secret. It feeds `limit_req`, the access log and `X-Real-IP` to Django.
- **Django** then reads `X-Real-IP` from nginx, exactly as on the VM: `PV_TRUSTED_PROXY_HOPS=0`. Every throttle, ADR 0015's meter and the log line use it (`common.throttles.client_ip`).
- **Without the Worker** (for example a first deploy reached on `run.app`), set `PV_TRUSTED_PROXY_HOPS=1` on the web image. That takes the address Google's front end appended to `X-Forwarded-For`, the one entry a caller can't write. This is already built (part 2).
- **Follow-up:** like the pipeline (its ADR 0031), count IPv6 callers by their /64, so one caller can't get a fresh limit for every address.

### 5. Rate limiting: three layers

- **At Cloudflare (exact, at the edge):**
  - the free managed WAF ruleset;
  - the Free plan's one rate-limit rule, on `/api/`. For example 200 requests per 10 seconds per IP (today's nginx rate of 20 a second), with a 10-second block. Like nginx's own limits, it's looser than the app's tightest ones, so ordinary callers get the app's 429 first.
  - More rules (separate ones for `/tiles/` or `/api/search`) need a paid Cloudflare plan. **[Maria]**
- **In nginx (per instance):** the existing `limit_req` zones, now keyed on the real client. They cover `/tiles/` and `/aerial/`, which the one Cloudflare rule doesn't. With at most 2 instances, a client gets at most twice the configured rate.
- **In the app (per process):** DRF's scoped throttles (`api/common/throttles.py`) already do what Maria suggested Django-Ratelimit for: per-view, per-IP limits on login, search, feedback and the admin. Adding Django-Ratelimit would add nothing, because it counts in the same Django cache. The counts are per process, so with 2 instances a client gets up to twice the limit. ADR 0015's detail budget is in the database, so it's already exact.
- **Not proposed: exact app-level counts.** That would mean a shared counter table, as the pipeline built in its ADR 0031. It costs a database write per request, and on Neon it would keep the database awake (section 7). Revisit if the Cloudflare rule and per-instance counts turn out not to be enough.

### 6. TLS, domain and the admin

- **TLS and DNS:** the Worker's custom domain on the `dicemi.org` zone creates the DNS record and the certificate. Production is `gis.dicemi.org`, staging `gis-staging.dicemi.org`. HSTS goes on in Cloudflare once HTTPS has worked for a week (DIC-1863 Q3).
- **The county hostname is open. [Maria + county IT]** `gis.vanburencountymi.gov` is in county IT's DNS, and a Worker custom domain needs the hostname in a Cloudflare zone. The options are:
  - keep `gis.dicemi.org` as the public address, with links from the county site;
  - Cloudflare's custom hostnames ("Cloudflare for SaaS"): county IT adds one CNAME, and Cloudflare issues the certificate;
  - ask county IT to move that one name.
- **Cloudflare Access on `/admin/*` and `/api/django-admin/*`,** as in the pipeline's ADR 0043. Staff get a one-time PIN by email (Zero Trust Free, up to 50 users), and the allowed addresses are kept in OpenTofu. Knox sign-in stays behind it, so the admin has two locks. The staff API routes under `/api/` stay behind Knox, the app's throttles and the Cloudflare rule.

### 7. Databases

**Parcel data: the viewer is a client of `parcel-data-api`, and connects to no parcel database.** (Maria, 2026-11-03.)
- **What changes in the viewer:** the parcel views (`api/parcels/`) stop reading `PV_DATABASE_URL` and call `parcel-data-api` from the server. The browser keeps calling the viewer's own `/api/` routes, so the public routes, the throttles and ADR 0015's meter stay where they are. How the calls map onto the contract waits for it to be confirmed on Linear.
- **The token:** a Knox service token in Secret Manager (section 8), sent as `Authorization: Token <token>` (Knox's default prefix, unless the API is configured otherwise). Only the django container gets it.
- **No db-dice connection, connector or budget.** The viewer needs no `roles/cloudsql.client` on db-dice and adds nothing to its 50 connections. Load on the parcel data becomes `parcel-data-api`'s to size; the viewer's share is bounded by its own instance cap and limits.
- **Tiles are open. [Maria]** Martin must not be pointed at db-dice. Two options are on the table on Maria's side:
  - a Martin sidecar (section 1) reading `parcel-data-api`'s database, with a read-only role and a small pool;
  - tiles served by `parcel-data-api` itself (for example `django-vectortiles`), which nginx proxies or the Worker routes to, and Martin goes away.

  Until that's settled, nothing that assumes Martin's database (its sidecar, its pool, nginx's `/tiles/` upstream on Cloud Run) gets built. The VM keeps today's Martin.

**Django's own database: Neon, as Maria suggested, with the limits spelled out. [Maria]** This is separate from the parcel data and not affected by the change above.
- **What it holds:**
  - staff accounts and Knox tokens;
  - ADR 0015's usage counters;
  - the published county config (the config store);
  - FEMA flood zones (the `environment` app, PostGIS).
- **Size:** small today, well under the Free plan's 0.5 GB. Most of it is one county's flood polygons; we'll measure it on staging. DIC-2412's later phases (wetlands, soils, contours) would grow it past 0.5 GB.
- **Compute hours,** for Maria's question:
  - The Free plan has 100 compute-unit hours a month. Capped at 0.25 CU, as the pipeline does, that's about **400 hours awake** out of the month's 720.
  - The database sleeps after 5 idle minutes. But every page load reads the config, so it's awake whenever anyone is using the viewer, plus 5 minutes.
  - **Staging** fits easily.
  - **A public production site** could plausibly use 250–450 hours. Business hours alone are about 220, plus evenings, weekends and each 5-minute tail.
  - Past the limit, Neon suspends the database until the month resets. The viewer would fall back to its baked config, but flood zones and staff sign-in would stop.
- **Recommendation:**
  - **Staging:** Neon Free, as in the pipeline.
  - **Production:** Neon too, capped at 0.25 CU, with a usage alert at 70 hours in the first week. Move to Neon's paid plan when the free hours run short, or before DIC-2412 phase 2 lands. Check the paid plan's current per-hour price before deciding. As a rough guide, a full month awake at 0.25 CU is about 180 CU-hours.
  - **A cheap way to stretch the free hours:** cache the published config in the API process for a minute or so. Config edits then show up within a minute.
- **Settings:**
  - Neon's **direct** connection string, not the pooled one (our psycopg pool keeps few connections), with `sslmode=require`;
  - `CONN_HEALTH_CHECKS`-style checks are already on: the pool tests each connection before handing it out.
- **Latency:** Neon has no Google regions. AWS `us-east-2`, the closest to `us-central1`, adds tens of milliseconds per query. The viewer runs one or two queries per page load or identify, so that's acceptable.
- **Backups:** Neon's Free plan restores only to a recent point. Production gets a nightly dump to a private R2 bucket, as in the pipeline's ADR 0039. That replaces today's manual volume backups in `infra/DEPLOY-CHECKLIST.md`.
- **The alternative** is a small Cloud SQL instance in the viewer project (about $10–12 a month, with backups included). It's simpler for a database that's always awake, but it isn't the team's standard.

### 8. Secrets, deploys and monitoring

- **Secrets in Secret Manager,** exposed as environment variables. Each variable is set only on the container that reads it, with pinned versions:

  | Secret | Container |
  |---|---|
  | `pv-django-secret-key` → `SECRET_KEY` | django, migrate job |
  | `pv-django-database-url` → `DATABASE_URL` (Neon) | django, migrate job, backup job |
  | `pv-parcel-data-api-token` → the Knox service token for `parcel-data-api` (variable name set with the client) | django |
  | `pv-origin-lock-secret` → `PV_ORIGIN_LOCK_SECRET` | nginx (and set by hand on the Worker) |
  | `pv-smtp-password`, `pv-service-keys` | django |
  | `pv-sentry-dsn` → `SENTRY_DSN` | django, jobs |

- **No parcel database URL** for Django or Martin: parcels come from `parcel-data-api` (section 7). If tiles stay with Martin, its database secret comes with that decision.
- **Passwords in URLs** must be percent-encoded (`@` → `%40`).
- **One runtime service account** for the service, with access only to these secrets. The deploy uses its own deployer account. Both, and every grant, are in the bootstrap root (section 10).
- **Deploys,** as in the pipeline:
  - a merge to `main` tags a release (B7);
  - the release builds the images into Artifact Registry in the viewer project, runs the migrate job, and updates **staging**;
  - **production** is a promotion of a version already running on staging;
  - the trigger is GitHub Actions with Workload Identity Federation (section 10), so there are no keys in GitHub.
- **Sentry** is already in the code: `api/common/error_logging_client.py` (sentry-sdk) and Map Buddy's copy of it. An empty `SENTRY_DSN` turns it off. Deploying needs:
  - a Sentry project for the viewer;
  - the DSN as a secret;
  - `SENTRY_ENVIRONMENT` set to `staging` or `production`;
  - the nightly backup job reporting failures, as the pipeline's does.

  Browser errors are a later step: the CSP report sink (`/api/csp-report`) already covers policy violations.

### 9. Map Buddy: stays where it is for now

- **No change yet.** It keeps running in `core-db-475718` on its `run.app` address, and the viewer calls it directly (`COUNTY.endpoints.mapBuddy`).
- **Its calls to the parcel API** go through Cloudflare like anyone's. They carry `X-PV-Service-Key` (DIC-2202), so the meter doesn't charge them. They're a few requests per chat, far under the rate rule.
- **Its own open items need a new owner now that Drake is leaving:** the outdated build on Cloud Run (AI quota off, `/docs` public), the quota store (DIC-1862) and the spend limit (B6).
- **Later:** the same Worker could route `/map-buddy-api/` to it. That gives one origin and puts Cloudflare in front of its paid endpoints.

### 10. Infrastructure as code: OpenTofu with a bootstrap root, as in `did-vaultwarden`

Revised 2026-11-04 at Maria's request (#105): the token and permission model follows `did-vaultwarden` (`tofu/bootstrap/`, `tofu/bootstrap/ci.tf` there), so every credential the project uses, and what it may do, is recorded in code.

- **Layout:**
  - `deploy/tofu/bootstrap/`: run by a person, rarely. It creates what the other roots depend on, including every runtime token and service account.
  - `deploy/tofu/modules/viewer/`, plus thin `envs/staging/` and `envs/prod/` roots that call it.
  - State for every root in one private R2 bucket (`pv-tfstate`), one state file per root.
- **One human-held Cloudflare bootstrap token, live for 24 hours.** A person creates it right before a bootstrap run, with a 24-hour expiry and the start date left empty, and deletes it afterward. Its scope is only:
  - Account: API Tokens Edit, and Workers R2 Storage Edit (the state and backup buckets);
  - Zone `dicemi.org` only (never "All zones"): DNS Edit.

  It's never stored. The local R2 state keys are derived from it (token id, and `sha256` of the value), so they stop working when it's deleted.
- **The bootstrap root creates the runtime tokens** as account-owned tokens (`cloudflare_account_token`; the user-level `cloudflare_api_token` resource can't be reached with the bootstrap token). Each has the narrowest scope that works, and its value is written straight into a Secret Manager secret:

  | Token | Scope | Read by |
  |---|---|---|
  | `pv-deploy-cloudflare` | zone `dicemi.org`: Workers Routes, DNS, Zone WAF; account: Workers Scripts, Access apps | the deploy workflow (env roots) |
  | `pv-ci-tfstate` | bucket `pv-tfstate`: R2 Item Read + Write | the deploy workflow |
  | `pv-backup-write` | the backup bucket: R2 Item Write | the nightly backup job |

  The exact permission groups are pinned by id in the code, as `did-vaultwarden` does. Those token values land in OpenTofu state, which is why state sits in a private bucket only the CI and bootstrap credentials can read.
- **GCP side, also in the bootstrap root:**
  - the project's APIs, Secret Manager containers (no values), Artifact Registry;
  - the runtime service account, with `secretAccessor` on only the secrets its containers read (section 8);
  - Workload Identity Federation for GitHub Actions: a pool whose condition pins this repo and its owner by numeric id and `refs/heads/main`, and a deployer service account that only the deploy workflow file (`job_workflow_ref`) can impersonate. No Google key and no secret is stored in GitHub; CI reads its Cloudflare and state credentials from Secret Manager.
  - The deployer's roles are listed one by one (Cloud Run admin on the viewer's service and jobs, `serviceAccountUser` on the runtime account only, Artifact Registry writer, `secretAccessor` on its own two secrets), not `editor`.
  - The person running bootstrap uses their own `gcloud auth application-default login`.
- **The module covers** what changes per environment: the Cloud Run service, its migrate and backup jobs, the Worker and its custom domain, the WAF and rate-limit rulesets, and the Access application for the admin.
- **Images are changed by each deploy,** so OpenTofu ignores them.
- **Staging differs by module inputs:** `gis-staging.dicemi.org`, no nightly backup, `--min-instances 0`. It keeps the Worker and the origin lock. That differs from the pipeline, whose staging has no Worker: here the Worker, the lock, the client IP and edge caching are the riskiest parts, so staging should test them.
- **Still by hand** (values, never permissions):
  - the bootstrap token, each time bootstrap runs;
  - the Neon projects and their connection strings;
  - other secret values (Django's key, SMTP, the `parcel-data-api` service token, the origin secret), added with `gcloud secrets versions add`;
  - Zero Trust switched on once;
  - four non-secret GitHub repo variables from `tofu output` (the WIF provider and the deployer account);
  - the first staff login.

### 11. Rough monthly cost (list prices, limited test traffic)

| Item | Production | Staging |
|---|---|---|
| Cloud Run `pv-viewer`: 1 warm instance (nginx 0.25 vCPU, Django 1 vCPU, Martin 0.5 vCPU if kept, about 1.5 GiB, CPU only while serving) | ~$15–25 | ~$0–3 (scales to zero) |
| Cloudflare: Free zone plan (WAF, 1 rate rule, Access up to 50 users) | $0 | $0 |
| Cloudflare Workers Paid (covers the whole account) | $5 | (shared) |
| Neon: Free plan; paid plan once it outgrows it (section 7) | $0 at first | $0 |
| R2 for backups and state | ~$0–1 | ~$0 |
| Egress from Cloud Run (less with edge caching) | ~$2–10 | ~$0–1 |
| Secret Manager, Artifact Registry, logging (mostly free tier) | ~$1–2 | ~$1 |
| **Total** | **~$25–45** | **~$1–5** |

- **These are estimates from published rates, not quotes.**
- **Compared with the first version,** this is down from ~$55–85 (the load balancer and Cloud Armor came to about $30 of it).
- **The warm instance** (`--min-instances 1`) is there because GeoDjango takes seconds to cold-start, and the first map move would otherwise wait for it.
- **Not included:** Map Buddy's cost, which is Anthropic tokens capped by its spend limit (B6), and `parcel-data-api` with its database, which aren't the viewer's.

### Still to decide

- **[Maria]:**
  - the GCP project (name, billing, region; ideally the region `parcel-data-api` runs in);
  - `parcel-data-api`'s contract for the viewer (endpoints, the service token, its own rate limits);
  - where tiles come from: a Martin sidecar on the new database, or the API (section 7);
  - Neon for production, or Cloud SQL (section 7);
  - whether one Cloudflare rate rule is enough (section 5).
- **[Maria + county IT]:** the county hostname (section 6).

## Part 2: code prep

**Done in this change.** It holds under every option above, and leaves the VM path as it was.

- **`$PORT`.** The API image already binds gunicorn to `${PORT:-8000}`. The web image now honours `PORT` too: `infra/nginx/cloud-run-env.sh` runs from the nginx entrypoint and rewrites `listen 80;`.
- **The client IP by hop count** (`PV_TRUSTED_PROXY_HOPS`, for Django and the web image), for a deploy reached without the Worker. It counts entries from the right of `X-Forwarded-For`; everything to their left can be forged.
  - Every Django throttle now keys on `client_ip`.
  - **This also fixes a bug on the VM:** DRF's default throttles keyed on the whole `X-Forwarded-For` when one was sent, so a client could reset its login limit by changing the header.
  - `THROTTLE_NUM_PROXIES` is gone.
- **The aerial cache fits in memory.** `PV_AERIAL_CACHE_MAX` (for example `64m`) shrinks nginx's 1 GB cache, since Cloud Run's disk is the instance's memory.
- **A liveness probe that needs neither the database nor the public host.** `GET /health/live` is answered before host validation and the HTTPS redirect, so an outage at Neon or `parcel-data-api` doesn't get healthy instances restarted. `/health` (with the database check) stays for uptime checks.
- **Database URLs that don't assume compose.** The URL's own options (`sslmode=require`, which Neon needs) are kept, and a percent-encoded Unix socket host is decoded (the Cloud SQL connector, should Django's own database go to Cloud SQL instead of Neon).
- **Tests** cover both paths: `api/common/tests/test_throttles.py`, `test_settings.py`, `test_middleware.py`, and `infra/test-web-image-cloud-run.sh` in CI.

**Next, once this ADR is accepted** (a separate PR, together with the OpenTofu files):
- the web image's `/api/` upstream set from the environment (`127.0.0.1` on Cloud Run, compose names on the VM);
- nginx's origin lock and the trusted `X-PV-Client-IP`, with tests in `infra/test-web-image-cloud-run.sh`;
- a fixed public `Host` to Django from `PV_PUBLIC_HOST`;
- the Worker script;
- the nightly backup job;
- the OpenTofu module.

**Held until Maria confirms the API contract and the tile decision:**
- the parcel views as a client of `parcel-data-api`, with its service token;
- anything for tiles on Cloud Run: a Martin sidecar and its pool, or nginx's `/tiles/` route to the API.

## Consequences

- **Cloudflare becomes part of the site.** If the Worker or the zone is misconfigured, the site is down even when Cloud Run is fine. The rollback is to turn the lock off (an empty secret) and point DNS at another path. Rotating the origin secret means changing it on the Worker and in Secret Manager together; requests fail in between.
- **gzip, request ids and the security headers stay in nginx,** because every request still goes through it. The first version's gzip gap (the load balancer routing `/api/` past nginx) no longer applies.
- **Each limit counts in its own place.** The Cloudflare rule is exact. nginx's limits and the app's throttles count per instance, which is acceptable while `--max-instances` is 2. Raising the instance cap means redoing these limits, and telling `parcel-data-api`'s owners.
- **The viewer depends on `parcel-data-api`.** If it's down or slow, identify, search and the parcel details fail; pages, the config and the aerials still load. Its latency is added to every parcel request, so the two should run in the same region.
- **Neon's free hours are a real ceiling for a public site** (section 7). Watch them in the first week.
- **The deploy docs need rewriting** for this path: `infra/DEPLOY-CHECKLIST.md`, `infra/HANDOFF-DRAKE-DEPLOY.md` (which assumes Drake), `SECURITY.md` (the limits in front of the app, TLS), and `infra/smoke-test.sh` (point it at the Cloudflare host; add `/api/health/live`). The compose files stay, for local work and as the fallback.
- **Images are built from release tags** (B7) into Artifact Registry, not on a host.
- **Superseded if approved:** the June plan (shared VM, host nginx vhosts, Certbot) recorded on DIC-1863 Q2/Q3, and this ADR's first version (a load balancer, Cloud Armor and three services).
