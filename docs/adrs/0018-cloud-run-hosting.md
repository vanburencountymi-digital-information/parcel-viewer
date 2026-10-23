# 18. Cloud Run hosting: a load balancer in front of three services

## Status

Proposed (DIC-2554, 2026-10-23), for Drake to approve or redline. Answers readiness blocker B9 (`docs/READINESS-CHECKLIST.md`). Choices marked **[Drake]** are his to make; the recommendation is what this ADR would settle if he agrees. Nothing here has been deployed or priced in the GCP console.

## Context

On 2026-10-19 Maria recommended on DIC-1863 that the viewer run as **its own Cloud Run deployment in its own GCP project**, not on the shared e2-small VM, and Drake agreed. The site is public and read-only, so rate limiting has to work at both the app and the hosting level (DIC-1863).

Everything in `infra/` was written for one VM running Docker Compose (`infra/docker-compose.prod.yml`):

| Piece | On the VM | What Cloud Run changes |
|---|---|---|
| `web` (nginx) | Static Vite bundle, security headers, CSP, `/api/` and `/tiles/` routing, `/aerial/` proxy with a 1 GB disk cache, `limit_req` per IP | No shared disk (the filesystem is memory), no Docker DNS (`resolver 127.0.0.11`), the port comes from `$PORT`, and every request arrives through Google's front end, so `$remote_addr` isn't the client |
| `django-api` | gunicorn, 1 worker × 4 threads, pool of 4; reached only from nginx | Instances scale out, each with its own pools; probes call the container directly |
| `martin` | Tiles from db-dice, pool of 8 | Same as the API: per-instance pools |
| `django-db` | A Postgres container with a volume (staff accounts, Knox tokens, metering counters, and the config store when `PV_WRITER_DATABASE_URL` is unset) | No volumes: it needs a home |
| TLS | The host proxy or Certbot | Domain mapping or a load balancer |
| Secrets | `.env` on the host | Secret Manager |

Fixed points: db-dice (shared Cloud SQL PostGIS, `max_connections` 50, 47 usable, other clients peaked at 16) stays where it is; Map Buddy already runs on Cloud Run in `core-db-475718`; the hostname is `gis.dicemi.org`, then `gis.vanburencountymi.gov` at launch (county IT does that DNS).

## Decision (proposed)

### 1. Services: an external load balancer routing to three Cloud Run services **[Drake]**

```
gis.dicemi.org ──> global external Application Load Balancer
                   (Google-managed certificate, Cloud Armor policy, HTTP→HTTPS redirect)
                    ├─ /api/*    → pv-api    (Django; the URL map strips /api)
                    ├─ /tiles/*  → pv-martin (Martin; the URL map strips /tiles)
                    └─ default   → pv-web    (nginx: pages, assets, headers, /aerial/, 404s)
```

- **`pv-web` is the existing web image**, unchanged except for its start-up settings (part 2). nginx keeps everything already tested: the security headers and CSP, `/` → `/demo/`, the `/demo/` and `/admin/` fallbacks, the `.md`, dotfile and `/map-buddy/` 404s, the `/map-buddy-api/` 404 (B4), and the `/aerial/` proxy and cache.
- **`pv-api` is the existing Django image** (`api/Dockerfile`, `production` target). `PV_SCRIPT_NAME=/api` stays, so the admin's links still carry the mount.
- **`pv-martin` is the upstream Martin image** with `infra/martin/martin.yaml` baked in or mounted from a secret, listening on 3000 as today (`gcloud run deploy --port 3000`).
- **All three use `--ingress internal-and-cloud-load-balancing`**, so the `run.app` URLs can't be used to get around Cloud Armor or to forge a client address.
- Migrations run as a **Cloud Run job** from the API image (`python manage.py migrate --noinput`) before traffic moves to a new revision, as `django-migrate` does in compose.

Alternatives:
- **No load balancer: `pv-web` as the front service** with Cloud Run domain mapping; nginx proxies `/api/` and `/tiles/` to the other services. Cheapest (no LB, no Cloud Armor), but domain mapping is a Preview feature that Google doesn't recommend for production, rate limits are per nginx instance (section 2), and nginx would have to call the other services over HTTPS with their own `Host` header. The API and Martin then need either public `run.app` URLs (anyone can bypass nginx) or internal ingress through Direct VPC egress from `pv-web`. That's more nginx rework than the LB's URL map.
- **Cloud Storage bucket + Cloud CDN for the static files**, with no nginx. Still needs the LB, and it loses what nginx does today: the page fallbacks, the 404 rules, per-location headers (the LB can add response headers, but not per path), and the `/aerial/` proxy (the viewer would then fetch Esri directly, which changes the CSP and Esri's terms of use). It's worth doing later, when the classic pages are gone (ADR 0017).
- **Everything through `pv-web`, LB in front only for TLS and Cloud Armor.** It keeps nginx as the one router, but every API and tile request is then proxied twice, and nginx needs the HTTPS-upstream rework above.

### 2. Hosting-level rate limiting: Cloud Armor on the LB, nginx `limit_req` kept as a second layer **[Drake]**

- **Cloud Armor (Standard) rate-based rules, keyed on the client IP**, mirroring today's nginx limits: `/tiles/` and `/aerial/` 60 req/s (burst 300), `/api/` 20 req/s, plus 5 req/s on `/api/parcels`, `/api/cohort` and `/api/search`. Excess → 429. Cloud Armor counts at the load balancer, so a limit holds however many instances are running.
- **nginx keeps its `limit_req` zones** (now keyed on the real client, part 2). They cost nothing and still cover `/aerial/`, the one path that spends someone else's quota (Esri) on a cache miss.
- **The app's own limits stay** (`api/common/throttles.py`, ADR 0015's meter). The throttle counters are per process (Django's local-memory cache), so with N instances a client gets up to N × the limit. The detail budget (ADR 0015) is in the database, so it's already exact.

Trade-off:

| | Cloud Armor | nginx `limit_req` only |
|---|---|---|
| Accuracy | One count at the edge, whatever the instance count | Per instance: up to `--max-instances` × the limit, and counts reset when an instance stops |
| Coverage | Every path, including `/api/` and `/tiles/` routed straight to their services | Only what passes through nginx |
| Cost | About $5 a month for the policy, $1 per rule, $0.75 per million requests, and it needs the LB (section 9) | Nothing |
| Change | GCP config (Drake) | Already in `infra/nginx.viewer.conf` |

If Drake picks no LB, cap `pv-web` at `--max-instances 2` so the per-IP ceiling is at most twice the configured rate, and accept that.

Alternative for exact app-level counts: point Django's throttle cache at the database (`DatabaseCache` in Django's own DB) or Memorystore. Not proposed for the test: it adds a write per request (database) or about $35 a month (Memorystore).

### 3. The client IP: a configured count of trusted proxies (done in code, part 2)

Google's front end appends the address it received from to `X-Forwarded-For`. Behind an external ALB, Cloud Run sees `<anything the client sent>, <client>, <LB>`. Without an LB it sees `<anything the client sent>, <client>`. Everything to the left of the client is forged by whoever sent the request, and so is any `X-Real-IP` (the front end passes it through).

- **`PV_TRUSTED_PROXY_HOPS`** says how many entries from the right to count: `2` behind the LB, `1` for Cloud Run alone, `0` (the default) on the VM, where nginx sets `X-Real-IP` and nothing else can reach the API.
- **One rule everywhere.** The Django side (`common.throttles.client_ip`) feeds every throttle (DRF's own included), the ADR 0015 meter and the access log. The nginx side (`$pv_client_ip`) feeds the `limit_req` zones, the access log and `X-Real-IP`.
- **This only holds if nothing can skip the proxies**, hence internal-and-LB ingress (section 1).
- **Verify on staging before testers arrive:** send `X-Forwarded-For: 198.51.100.1` through the LB and check that the API's access log shows your own address. If Cloud Run turns out to add an entry of its own behind the LB, the count is 3; it's a setting, not code.

Alternative: have the LB set a header of its own (a custom request header) and trust only that. That would be sturdier than counting, but it depends on which variables the LB exposes; check this during the staging check.

### 4. TLS and domain: a Google-managed certificate on the LB **[Drake]**

- **A Google-managed certificate for `gis.dicemi.org`** on the LB's HTTPS forwarding rule, with an `A` record pointing at the LB's reserved static IP. A second forwarding rule on port 80 redirects to HTTPS. Certbot is no longer needed.
- At launch, add `gis.vanburencountymi.gov` to the certificate once county IT points DNS at the same IP. The code already reads hostnames from settings (`ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `PV_CORS_ORIGINS`, Map Buddy's `ALLOWED_ORIGINS`).
- **HSTS** goes on as an LB custom response header (or `SECURE_HSTS_SECONDS` plus an nginx `add_header`) once HTTPS has worked for a week. It's open on DIC-1863 Q3.
- Without an LB (section 1, alternative), this becomes Cloud Run domain mapping, a Preview feature.

### 5. Database access: the Cloud SQL connector, with a fixed connection budget **[Drake]**

- **The connector built into Cloud Run** (`--add-cloudsql-instances <db-dice connection name>`): a Unix socket at `/cloudsql/<project>:<region>:<instance>`, encrypted, and authorized by each service's own service account (`roles/cloudsql.client` granted in db-dice's project). No authorized networks or static egress IP. The settings now accept that socket in a URL: `postgis://user:password@%2Fcloudsql%2F<project>%3A<region>%3A<instance>/<db>` (part 2).
- Alternatives:
  - **Public IP with authorized networks:** Cloud Run's egress addresses change, so this needs Cloud NAT with a static IP (about $1 a month per IP, plus NAT data charges) and `sslmode=require` in the URL (now kept; part 2).
  - **Private IP:** a VPC in the viewer project peered with db-dice's, plus Direct VPC egress. More network to own, for no gain at this size.
- **Connection budget on db-dice (B2).** Every instance has its own pools, so the ceiling is per instance × `--max-instances`:

  | Service | Per instance | Max instances | Ceiling |
  |---|---|---|---|
  | `pv-api` | 1 worker × parcels pool 4 (`DB_POOL_MAX=4`) | 2 | 8 |
  | `pv-martin` | `pool_size` 4 (down from 8: a one-line `martin.yaml` change once approved) | 2 | 8 |
  | **Viewer total on db-dice** | | | **16** |

  That's the VM stopgap's 16. With other clients' measured peak of 16, db-dice stays at 32 of its 47 usable. Django's own database and the config store aren't on db-dice (section 6), so they don't count. Cloud Run's `--concurrency` for `pv-api` is 4 (workers × threads), so two instances serve 8 requests at once, as the VM did.
- Raising either cap needs this table redone. **PgBouncer (DIC-316)** or Cloud SQL's managed connection pooling (Enterprise Plus edition only) would lift the ceiling; neither is needed for a limited test.

### 6. Django's own database: a small Cloud SQL instance in the viewer project **[Drake]**

- **A new Cloud SQL for PostgreSQL instance with PostGIS** (the smallest shared-core tier, 10 GB SSD, automated daily backups and point-in-time recovery) in the viewer's project. It holds what `django-db` holds today: staff accounts, Knox tokens, ADR 0015's counters, and the config store (`PV_WRITER_DATABASE_URL` stays unset). It's reached through the same connector.
- It keeps Maria's rule that apps don't share databases, keeps its connections off db-dice's budget, and gives the staff accounts backups without a volume to look after (`infra/DEPLOY-CHECKLIST.md` currently asks for manual volume backups).
- Alternatives:
  - **A separate database on db-dice:** no new cost, backed up with db-dice. But it shares an instance with other apps, and its pools (default + config store, up to 8 per API instance) count against the 47.
  - **Keep a container:** not possible on Cloud Run, which has no persistent volumes.

### 7. Secrets: Secret Manager, one service account per service

| Secret | Read by | Today |
|---|---|---|
| `pv-django-secret-key` → `SECRET_KEY` | `pv-api`, migrate job | `DJANGO_SECRET_KEY` in `.env` |
| `pv-django-database-url` → `DATABASE_URL` | `pv-api`, migrate job | built by compose from `DJANGO_DB_PASSWORD` |
| `pv-parcels-database-url` → `PV_DATABASE_URL` | `pv-api` | `.env` |
| `pv-martin-database-url` → `MARTIN_DATABASE_URL` | `pv-martin` | `.env` |
| `pv-smtp-password`, `pv-service-keys` | `pv-api` | `.env` |
| `pv-sentry-dsn` → `SENTRY_DSN` | `pv-api` (and Map Buddy's own) | not yet created (section 5 of the checklist) |

- They're exposed as environment variables (`--set-secrets SECRET_KEY=pv-django-secret-key:3`), so the settings read them as they do today. **Pin version numbers**, not `latest`: an instance reads the secret when it starts, so `latest` can change what a running revision uses.
- Each service runs as **its own service account**, with `secretAccessor` on its own secrets only. That's the Cloud Run form of compose's "each service gets only the settings it reads".
- **Passwords in URLs must be percent-encoded** (`@` → `%40`); the settings decode them.
- **[Drake]:** who creates and rotates the secrets, and whether the deploy runs from GitHub Actions (Workload Identity Federation, no keys) or by hand.

### 8. Map Buddy: stays where it is for the test

- It keeps running in `core-db-475718` at its `run.app` URL. The viewer calls it directly (`COUNTY.endpoints.mapBuddy`), as it does now. Its own work (redeploy, quota store, spend limit) stays in B6 / DIC-1862.
- Its calls to the parcel API (`PARCEL_API_BASE=https://gis.dicemi.org/api`) go through the LB and Cloud Armor like anyone's. They carry `X-PV-Service-Key`, so the meter doesn't charge them, but Cloud Armor still counts them per Google egress address. They're a few requests per chat, well under 20/s.
- **Follow-up (B6):** Map Buddy's log line reads `X-Real-IP` (`map-buddy/backend/common/request_context.py`, shared with `api/common`), which on Cloud Run is whatever the client sent. Port the hop count there.
- **Alternative [Drake]:** move Map Buddy into the viewer project behind the same LB at `/map-buddy-api/`. That gives one origin (no CORS), Cloud Armor in front of the paid endpoints, and one place for its secrets. It's a later step: it needs a new project for its Anthropic secret and replaces the `/map-buddy-api/` 404 with a route.

### 9. Rough monthly cost (us-central1, list prices, limited test traffic)

| Item | Recommended | No-LB alternative |
|---|---|---|
| External ALB (up to 5 forwarding rules, about $0.025/hour) + data processing | ~$18–20 | — |
| Cloud Armor Standard: policy + ~5 rules + requests | ~$10–15 | — |
| Cloud Run: `pv-api` with 1 warm instance (1 vCPU, 1 GiB, idle rate) | ~$13–20 | ~$13–20 |
| Cloud Run: `pv-web`, `pv-martin` (scale to zero) | ~$0–5 | ~$0–5 |
| Cloud SQL for Django's DB (shared core, 10 GB, backups) | ~$10–12 | ~$10–12 |
| Internet egress (tiles, GeoJSON, pages; 20–100 GB) | ~$2–12 | ~$2–12 |
| Secret Manager, Artifact Registry, logging (mostly free tier) | ~$1–2 | ~$1–2 |
| **Total** | **~$55–85** | **~$25–50** |

These are estimates from published rates, not a quote; check them in the pricing calculator. The free tiers are per billing account. Map Buddy's cost is Anthropic tokens, capped by the spend limit (B6), and isn't counted here. A warm `pv-api` instance (`--min-instances 1`) is in both columns: GeoDjango takes seconds to cold-start, and the first map move would otherwise wait for it.

### Also needed from Drake

- **The project:** name, billing account, region (us-central1 to sit next to db-dice), and who has which roles.
- **Staging:** Maria's gate requires a staging deploy (B3). Proposed: the same three services and job with a `-staging` suffix in the same project, behind their own hostname (for example `gis-staging.dicemi.org`), sharing db-dice's read role but with their own Django database.
- **DNS** for `gis.dicemi.org` (who changes the record, and when).

## Part 2: code prep, right under every option above (done in this change)

- **`$PORT`.** The API image already binds gunicorn to `${PORT:-8000}`. The web image now honours `PORT` too: `infra/nginx/cloud-run-env.sh` runs from the nginx entrypoint and rewrites `listen 80;`. Martin keeps port 3000, and Cloud Run is told so (`--port 3000`).
- **Client IP by hop count** (section 3): `PV_TRUSTED_PROXY_HOPS` for Django and for the web image. Every Django throttle now keys on `client_ip`. Before this, DRF's default throttles and the views' `ScopedRateThrottle` keyed on the whole `X-Forwarded-For` when one was sent, so a client could reset its login limit by changing the header, even on the VM. `THROTTLE_NUM_PROXIES` is gone.
- **The aerial cache fits in memory:** `PV_AERIAL_CACHE_MAX` (for example `64m`) shrinks nginx's 1 GB cache, since Cloud Run's disk is the instance's memory.
- **A liveness probe that needs neither the database nor the public host:** `GET /health/live` is answered by `common.middleware.LivenessMiddleware` before host validation and the HTTPS redirect. Use it for Cloud Run's startup and liveness probes, so a db-dice outage doesn't get healthy instances restarted. `/health` (with the database check) stays for uptime checks through the LB.
- **Database URLs that don't assume compose:** a percent-encoded Unix socket host (the Cloud SQL connector) is decoded, and the URL's own options (`sslmode=require`) are kept beside the pool settings.
- The VM path is unchanged: without these settings, the images, compose files and nginx config behave as before. Tests cover both (`api/common/tests/test_throttles.py`, `test_settings.py`, `test_middleware.py`, `infra/test-web-image-cloud-run.sh` in CI).

## Consequences

- **Gzip for `/api/` (needs fixing if routing goes straight to the services).** nginx compresses API responses today (the bbox GeoJSON is about 2 MB). With the LB routing `/api/` straight to Django, nothing does. Before the test, either add Django's `GZipMiddleware` or enable Cloud CDN compression on that backend. Martin compresses its own tiles.
- **Request ids** for API calls are minted by Django rather than nginx (ADR 0001 still holds; the id is in the response and every log line).
- **The deploy docs need rewriting** once this is approved: `infra/DEPLOY-CHECKLIST.md`, `infra/HANDOFF-DRAKE-DEPLOY.md`, `SECURITY.md` (hosting-level limits, TLS), and `infra/smoke-test.sh` (point it at the LB host; add `/api/health/live`). The compose files stay for local work and as the fallback.
- **The web image is no longer built on the host.** Images are built from a release tag (B7) and pushed to Artifact Registry in the viewer project.
- **App-level throttles count per instance** (section 2). That's acceptable while `--max-instances` is 2; revisit if it grows.
- Superseded if approved: the June plan (shared VM, host nginx vhosts, Certbot) recorded on DIC-1863 Q2/Q3.
