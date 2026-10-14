# Parcel viewer API (Django)

The parcel API, in GeoDjango (DIC-2146). It replaced the FastAPI backend with the same URLs and
JSON (ADR 0011), so the viewer and its tests didn't change, and it's the only backend since
FastAPI was retired (DIC-2150). nginx serves it at `/api/`; production runs it under gunicorn
(`infra/docker-compose.prod.yml`), the dev stack under `runserver` with `api/` bind-mounted.

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
| `common/` | Health check, database router, request ids, CORS, error answers, rate limits, validation, and the logging and Sentry modules shared with Map Buddy (a CI step keeps them identical) |
| `parcels/` | Read-only models over the assessing and geo tables |
| `county_config/` | Published county config, map style, the config store (`config.config_versions`), layer discovery |
| `wms/` | The server-side proxy for the federal WMS overlays |
| `feedback/` | Data-error reports (emailed) and the browser error beacon |

It talks to three databases (ADR 0004): Django's own, the shared parcel database (read-only,
ADR 0007), and the config store table (ADR 0010).

## Checking the contract

`tools/api-contract` replays the recorded requests and compares the answers with the
snapshot taken from the FastAPI backend before it was retired (the frozen contract):

```bash
python ../tools/api-contract/contract.py check http://localhost:8001
```

A route is ported when its diff is empty (ADR 0011). Decisions are in `../docs/adrs/`.
