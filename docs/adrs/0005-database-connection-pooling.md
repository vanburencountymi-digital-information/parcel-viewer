# 5. Database connections: Django's psycopg pool, capped at 5 per worker

## Status

Accepted (DIC-2148)

## Context

The shared database (db-dice) has a fixed connection budget that other apps share. The production rehearsal measured the viewer's share at API 5 + Martin 8 (DIC-1884). The FastAPI backend pools with `psycopg_pool`, with statement timeouts and TCP keepalives (DIC-1853, DIC-1872).

## Decision

- **Django's built-in psycopg 3 pool** (`OPTIONS["pool"]`, Django 5.1+) on every alias: at most **5** connections per worker (`DB_POOL_MAX`), 10 s to get one.
- **Gunicorn runs 2 workers**, so the API holds at most 10 parcel connections.
- **Same guards as FastAPI:**
  - 10 s statement timeout (`DB_STATEMENT_TIMEOUT_MS`);
  - 5 s connect timeout;
  - TCP keepalives;
  - 10 s `tcp_user_timeout`, so a dead connection fails in seconds.
- **`application_name = parcel-viewer-django`**, so its connections can be counted apart in `pg_stat_activity`.
- Tests use `common.test_runner.PooledTestRunner`, which closes the pools before the test database is dropped.

## Consequences

- During the parallel run (DIC-2150), both backends hold connections. Check the total against the budget before running both against db-dice. The DIC-590 split removes the shared-budget risk.
- Raising workers or `DB_POOL_MAX` changes the budget: update this ADR when it does.
