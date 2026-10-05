# API contract harness

Pins down what the parcel API returns, so the GeoDjango port (DIC-2146) has a finish line:
**a route is ported when its `diff` against the FastAPI backend is empty** and its unit
contract tests pass on Django. Phase 1 of the port, DIC-2147.

## Run it

Standard library only; Python 3.12. Run from the repo root, with the local stack up.

```bash
python tools/api-contract/contract.py diff http://localhost:8080/api http://localhost:8001
```

| Command | What it does |
| --- | --- |
| `record BASE` | Replay the catalogue against one backend. Writes response **shapes** to `snapshot/shapes.json` (committed) and full responses to `.out/` (git-ignored). |
| `check BASE` | Replay and compare against `snapshot/shapes.json`. Catches a field renamed, dropped, retyped or turned nullable. |
| `diff A B` | Replay each request against both backends a moment apart and compare status, contract headers and full bodies. This is the port's done-check. |

`--only REGEX` limits any command to matching request names. Set `PV_ADMIN_TOKEN` to
include the three admin reads; without it they're skipped. Unit tests for the harness:
`python -m unittest discover -s tools/api-contract`.

## What is compared

- **Status, and these headers:** content type, cache control, `X-Content-Type-Options`,
  the CORS headers, `Retry-After`, `WWW-Authenticate`. Date, request id, server and
  length vary per request and are ignored.
- **The JSON body, exactly.** Two things only warn: key order, and `1` vs `1.0`.
- **Rows matched by id.** `/parcels` and `/cohort` have no `ORDER BY`, so lists of
  objects with an `id` are compared by id, and a different order is only a warning.
- **`compare: "shape"`** for results cut off at their limit (the 4,000-parcel bbox,
  cohorts over their limit). Which rows come back is arbitrary there, so only the row
  count and structure are compared.
- **`compare: "status"`** for the WMS proxy's pass-through image, whose bytes come from
  USFWS.

## Why shapes, not responses, are committed

The API reads the live shared database, so recorded values drift as assessing data
changes. The repository is public, and parcel responses carry owner names and addresses.
The snapshot keeps only structure (keys, value types, statuses, headers); `diff` does the
value-for-value comparison live.

## Safety

The catalogue never sends a request that would email the county inbox, write config, or
log a fake client error. Those routes are only called with requests they reject, and
`test_contract.py` enforces that. Requests run one at a time with a 150 ms pause, to go
easy on the shared database: about 70 requests in 20–25 s.

## Known issues

- `known_issue` marks a route that's broken today. Its response is reported but never
  recorded or failed on, so a bug isn't frozen into the contract.
  `/streetview-target` returns 500 (DIC-2152: `geo.address_points.full_address` was
  renamed to `fulladdr`).
- `/docs` and `/openapi.json` aren't in the catalogue. They're environment config
  (`PV_API_DOCS`), not contract; the unit tests cover the default.

## The unit contract tests are the other half of the spec

`backend/app/tests/test_api_contract.py` and the router tests (DIC-1874) pin admin
gating, input validation, error hiding and rate limits, with the database mocked. Every
route has at least one unit test except `GET /config` (JSON). Because the database is
mocked there, real SQL is only exercised here.
