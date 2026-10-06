# Parcel viewer API (Django)

The GeoDjango replacement for the FastAPI backend in `backend/` (DIC-2146). It keeps the same
URLs and JSON, so the viewer and its tests check it unchanged. Until the swap (DIC-2150) it runs
beside FastAPI on port 8001, and the viewer keeps using FastAPI.

**Status:** porting the routes (DIC-2149). At parity so far: `/health`, the parcel reads (`/parcel/{id}`, `/history`, `/parcels`, `/search`, `/nearest-road`, `/streetview-target`) the cohorts (`/cohort`, `/cohort/geographies`), and config: `/config`, `/config.js`, `/style.json`, the config store (`/config/{county}/draft`, `publish`, `versions`, `rollback`) and `/admin/discover/layers`. `/wms-proxy`, `/report-error` and `/client-errors`, with FastAPI's request ids, logs, CORS and error answers. Every route in the contract catalogue now matches FastAPI; the swap behind nginx is next (DIC-2150).

## Run it

From `api/`, with the viewer stack's `.env` in the repo root:

```bash
make build && make up        # API on http://localhost:8001, plus its own Postgres
make migrate                 # Django's own tables (first run only)
make test                    # the test suite, against the local database only
```

`make lint`, `make typecheck` and `make check` match CI.

## How it's laid out

| Path | What it holds |
| --- | --- |
| `config/` | Settings (`base`, `test`) and URLs |
| `common/` | Health check, database router, request ids, CORS, error answers, rate limits, validation, and the logging and Sentry modules shared with FastAPI and Map Buddy |
| `parcels/` | Read-only models over the assessing and geo tables |
| `county_config/` | Published county config, map style, the config store (`config.config_versions`), layer discovery |
| `wms/` | The server-side proxy for the federal WMS overlays |
| `feedback/` | Data-error reports (emailed) and the browser error beacon |

It talks to three databases (ADR 0004): Django's own, the shared parcel database (read-only,
ADR 0007), and the config store table (ADR 0010).

## Checking parity with FastAPI

```bash
python ../tools/api-contract/contract.py diff http://localhost:8080/api http://localhost:8001
```

A route is ported when its diff is empty (ADR 0011). Decisions are in `../docs/adrs/`.
