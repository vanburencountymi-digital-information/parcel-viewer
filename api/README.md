# Parcel viewer API (Django)

The GeoDjango replacement for the FastAPI backend in `backend/` (DIC-2146). It keeps the same
URLs and JSON, so the viewer and its tests check it unchanged. Until the swap (DIC-2150) it runs
beside FastAPI on port 8001, and the viewer keeps using FastAPI.

**Status:** porting the routes (DIC-2149). At parity so far: `/health`, the parcel reads (`/parcel/{id}`, `/history`, `/parcels`, `/search`, `/nearest-road`, `/streetview-target`) and the cohorts (`/cohort`, `/cohort/geographies`). Still to come: config and style, the config store, the WMS proxy and error reports.

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
| `common/` | Health check, database router, Sentry setup, shared enums |
| `parcels/` | Read-only models over the assessing and geo tables |
| `county_config/` | The county config store (`config.config_versions`) |

It talks to three databases (ADR 0004): Django's own, the shared parcel database (read-only,
ADR 0007), and the config store table (ADR 0010).

## Checking parity with FastAPI

```bash
python ../tools/api-contract/contract.py diff http://localhost:8080/api http://localhost:8001
```

A route is ported when its diff is empty (ADR 0011). Decisions are in `../docs/adrs/`.
