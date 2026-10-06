# 12. Request validation and JSON encoding match FastAPI during the port

## Status

Accepted (DIC-2149)

## Context

ADR 0011 requires the Django API to answer exactly as FastAPI does. Three FastAPI behaviours differ from DRF's defaults:

- **Validation errors.** FastAPI answers bad parameters with 422 and Pydantic's errors, `{"detail": [{"type", "loc", "msg", "input", "ctx"}]}`. DRF serializers produce a different shape and wording.
- **Encoding.** FastAPI writes an integral Decimal as an int (`numeric` 100 → `100`) and keeps a datetime's `+00:00`. DRF writes `100.0` and `Z`.
- **Response shapes.** The routes return rows shaped by hand, not by serializer classes.

## Decision

- **Parameters are validated with Pydantic models** (`*/params.py`) carrying FastAPI's exact constraints. `common.validation` renders failures as FastAPI does: 422, `loc` prefixed with `query`/`path`/`body`, no `url`. Path parameters are matched as text, so a non-integer id gets FastAPI's 422, not Django's 404.
- **One JSON renderer** (`common.renderers.FastApiCompatibleJSONRenderer`) is the default and only renderer. It encodes Decimals and datetimes as FastAPI does, with no browsable API.
- **Raw rows are dicts, with JSON columns parsed** (`common.db`), as FastAPI's psycopg returned them. Django's backend leaves `jsonb` as text.
- **Responses are shaped by presenter functions** (`*/presenters.py`) that name their keys, standing in for DRF serializers during the port. Where FastAPI returns a whole projected row, the SQL's column list is the allowlist.

## Consequences

- The contract diff can be empty, including error bodies. Group 1 (the 6 parcel read routes, 28 requests) matched on the first run.
- Pydantic stays a dependency alongside DRF.
- After cutover, routes can move to DRF serializers one at a time. That changes error and number formatting, so each move is a contract change, checked by the e2e suite.
