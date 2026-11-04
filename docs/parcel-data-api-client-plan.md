# Plan: the viewer's API as a client of `parcel-data-api`

**Status:** approved 2026-11-04. Phase 1 is built (DIC-2802). Phase 2 waits for Maria's contract (DIC-2779).

**Background.** Parcel data is moving out of db-dice into a private database behind `parcel-data-api` (Knox token auth). The viewer's Django API becomes a server-side client of it (ADR 0018, #105). `docs/parcel-data-api-needs.md` lists every db-dice read today. This plan covers how `api/` changes over to the new source without changing what the browser sees (ADR 0011).

## 1. One seam: `ParcelSource`

Every parcel read goes through one interface, `parcels.sources.ParcelSource`. Views call it and never see SQL. Most of this already exists: `ParcelRepository` holds all the parcel SQL. One part leaks today. `CohortView` builds a SQL predicate and passes it to the repository, and it catches psycopg's `DataError`/`InternalError` itself.

| Method | Route(s) | Returns (same dict shape as today's rows) |
|---|---|---|
| `get_parcel(id)` | `GET /parcel/{id}` | full row with `geojson`, or `None` |
| `in_bbox(w, s, e, n, limit)` | `GET /parcels` | feature rows with `geojson` |
| `search(tokens, limit)` | `GET /search` | rows, best match first |
| `history(id, limit)` | `GET /parcel/{id}/history` | ledger rows, newest first |
| `nearest_road_point(lng, lat)` | `GET /nearest-road` | `{lng, lat}` or `None` |
| `streetview_target(id)` | `GET /streetview-target` | anchor, road point, address |
| `cohort(selector, limit)` | `POST /cohort` | `CohortResult(rows, center, pin)`: the rows, the extent's centre, and the PIN for a buffer label |
| `geographies(kind)` | `GET /cohort/geographies` | `[{id, name}]` |
| `ping()` | `GET /health` | `True` / `False` |

- **Rows keep the database's column names.** So `presenters.py` and ADR 0015's `meter_rows` don't change. The HTTP implementation maps the contract's JSON onto those names in one adapter module. If the contract renames a field, only the adapter changes.
- **Cohort validation stays in the viewer.** `cohort_query.build_predicate` still runs in the view first, so a bad selector is a 400 before any query or network call. The view then passes the validated selector to `source.cohort(...)`. The SQL source builds the predicate itself, and the API source sends the selector on.
- **Selection:** `get_parcel_source()` returns the source named by the `PV_PARCEL_SOURCE` setting, built once per process. Views call it the way they now build `ParcelRepository()`. Tests inject a fake, as they do now.

## 2. `sql` source (the default, no behaviour change)

`SqlParcelSource` is today's `ParcelRepository`, with its SQL unchanged. It also takes over the cohort predicate and the PostGIS-rejection handling from `CohortView` (it raises `ParcelSourceRejected`, which the view maps to the same 400 "that area couldn't be processed"). `PV_PARCEL_SOURCE` defaults to `sql`, so dev, CI, the e2e fixture and the VM run exactly as now.

## 3. `api` source (HTTP client)

`ApiParcelSource` in `parcels/sources/http.py`.

- **Settings:**
  - `PV_PARCEL_SOURCE=sql|api`;
  - `PARCEL_DATA_API_BASE`, the base URL (https only; plain http only to a loopback host, for local work and tests);
  - `PARCEL_DATA_API_TOKEN`, the Knox service token. On Cloud Run it comes from Secret Manager as an env variable on the django container only (ADR 0018 section 8, `pv-parcel-data-api-token`, pinned version).
  - A Django system check fails startup in `api` mode when either value is missing.
  - Also tunable: `PARCEL_DATA_API_TOKEN_PREFIX` and the `PARCEL_DATA_API_*_TIMEOUT_S` settings (connect, read, cohort, health), plus `PARCEL_DATA_API_HEALTH_CACHE_S`.
- **Auth:** `Authorization: Token <token>`, Knox's default prefix. The prefix is a setting in case the API changes it. The token is attached only to requests to the base URL's host, is never logged, and never reaches the browser. The browser keeps calling the viewer's own `/api/` routes.
- **HTTP library:** `httpx` (a new dependency), with one pooled client per process. Keep-alive matters because `/parcels` is called on every map move. The standard library opens a new TLS connection per call.
- **Timeouts:** connect 2 s. Read 5 s for the interactive reads (`/parcel`, `/parcels`, `/search`, history, road, Street View), 15 s for cohort, and 2 s for health. All are settings, and all stay well under gunicorn's timeout.
- **Retries:** one retry on a connect error or a 502/503/504, after a short backoff (about 200 ms plus jitter). Only idempotent reads are retried. There's no retry after a read timeout (the caller has already waited), on 429, or on 4xx.
- **Tracing:** the viewer's request id goes out as `X-Request-ID`, so a slow call can be matched in both services' logs (DIC-2203 stays retrofit-friendly).
- **Paths:** placeholders marked `TODO(DIC-2779)` in one table at the top of the module. Phase 1 guesses no response shapes beyond that.

## 4. Errors: the same 503s as today

Two source-neutral exceptions in `parcels.sources.errors` go to `common.exceptions.api_exception_handler`. They return the exact bodies the database errors return now, so the front end's try-again states don't change.

| Upstream | Viewer answers |
|---|---|
| connection refused or reset, DNS failure, 5xx after the retry | 503 `{"error": "database unavailable, try again"}` (`ParcelSourceUnavailable`) |
| read timeout, 429 | 503 `{"error": "database busy, try again"}` (`ParcelSourceBusy`) |
| 401/403 (a bad or expired token) | 503 unavailable, logged as an **error** (it's our misconfiguration, not an outage) |
| 404 on a single parcel | `None`, so the existing 404 "Parcel not found" |
| 400 on a cohort area | `ParcelSourceRejected` → the existing 400 |
| a malformed body | 503 unavailable, logged as an error |

## 5. Metering (ADR 0015) stays in the viewer

Views keep calling `meter_rows(request, rows)` and `finish(...)` on whatever the source returns, so the per-county detail budget, the service-key exemption (DIC-2202) and the counters in the Django database are unchanged. The viewer's service token must not be metered per record a second time upstream (contract question 6).

## 6. `/health`, layer discovery and tiles

- **`/health`:** `HealthService` asks the source. In `sql` mode that's `SELECT 1` on `PARCELS`, as now. In `api` mode it calls `parcel-data-api`'s health endpoint (a TODO path), with a 2 s timeout and the result cached for about 15 s, so uptime checks don't add load upstream. `/health/live` (#105) doesn't touch either, so an upstream outage never restarts healthy instances.
- **`/admin/discover/layers`** reads the Postgres catalogue for Martin's `geo.*_tiles` functions. It depends on where tiles come from, which is open (ADR 0018 section 7). It stays SQL-only. In `api` mode it answers 503 "layer discovery isn't available with parcel-data-api yet", and the console shows its existing error. It gets revisited once Maria decides on tiles.
- **Martin tiles:** no change in this work. The VM keeps today's Martin. Nothing for Cloud Run tiles gets built until the tile decision.

## 7. Phases

**Phase 1 (now, one PR):**
1. Add `parcels/sources/` with the interface, the errors, `get_parcel_source()` and the settings plus the system check.
2. Move the SQL behind `SqlParcelSource`, including the cohort predicate and the rejection handling. Switch the views and `HealthService` to the seam. Update the tests that patch `parcels.views.ParcelRepository`.
3. Add the `ApiParcelSource` skeleton with TODO paths. Unit tests run it against a fake server (`http.server` on a thread): the auth header, timeouts, one retry, the error table in section 4, 404 → `None`, and the token never in logs.
4. **No behaviour change:** the `django-api` tests, isv-harness and one full e2e run stay green with `PV_PARCEL_SOURCE` unset.

**Phase 2 (after Maria says the endpoints are live):**
- Fill in the real paths and the adapter. Write contract tests against recorded responses, plus a smoke run against staging.
- Flip staging to `api`. Compare responses route by route with `sql` on the same parcels (identical JSON apart from float noise). Then flip prod. Rollback is setting `PV_PARCEL_SOURCE=sql`, while db-dice still has the data.
- Decide `/health` and discovery for good, once the contract and the tile decision land.
- Make `PV_DATABASE_URL` optional in `api` mode. Phase 1 still requires it, because the `PARCELS` alias is always configured. Once nothing in `api` mode reads it, the viewer can start with no db-dice URL at all.

**Out of scope:** Map Buddy's knowledge base with `KB_BACKEND=dice` (it's off by default; noted in the inventory), tiles, and OpenTofu.
