# 4. The Django API lives in `api/`, with three databases

## Status

Accepted (DIC-2148, part of the GeoDjango port DIC-2146)

## Context

The parcel API moves from FastAPI to GeoDjango (plan: "Parcel viewer backend: FastAPI to GeoDjango"). It could be its own repo, an app in the PostGIS Manager API, or a folder here. During the port it must be compared with FastAPI request by request (`tools/api-contract`), pass the unchanged e2e suite, and swap in behind the same nginx.

The API needs three kinds of data: Django's own tables (auth, sessions, admin), the shared parcel tables another pipeline owns, and the existing county config store.

## Decision

- **An `api/` folder in this repo**, built from the team's Suggested Architecture Boilerplate and laid out like automation-ops-core. The PostGIS Manager API has been in Backlog since July and does data sync. Team precedent keeps an API beside its front end (cdbg-platform `api/`, county-directory-admin).
- **Apps:**
  - `common` (health, database router, Sentry setup, enums);
  - `parcels` (read-only models);
  - `county_config` (the config store; not `config`, which is the project package).
- **Three database aliases**, routed by app (`common/db_routers.py`):
  - `default`: Django's own tables. The only database `migrate` touches.
  - `parcels`: the shared parcel database, read-only (ADR 0007).
  - `config_store`: `config.config_versions` (ADR 0010).
- It runs beside the viewer stack under the compose profile `django` on port 8001, until the swap (DIC-2150).
- **mypy is configured in `api/pyproject.toml`**, not the root one (an exception to ADR 0003): the Django and DRF plugins need the project's settings and dependencies, so it runs in the API container, as in automation-ops-core. Ruff still uses the root config.

## Consequences

- One PR can change the API, the harness and the e2e tests together.
- Tests never touch the shared database: in tests, the `parcels` and `config_store` aliases mirror the local test database.
- A cross-database relation is refused by the router, so parcel data can't be joined to Django's tables in the ORM.
