# Architecture decision records

Short records of significant decisions: what we chose and why. Add one when a decision is hard to reverse or would surprise a newcomer. Update this list in the same change. Older decisions live in `engine/DECISIONS.md`.

| # | Decision | Summary |
|---|---|---|
| [0001](0001-observability-logs-request-ids-sentry.md) | Observability | Request ids on every request and log line; JSON logs to stdout; Sentry (via `ErrorLoggingClient`) only when `SENTRY_DSN` is set; no personal data in logs or error reports. |
| [0002](0002-automatic-semantic-versioning.md) | Versioning | Conventional Commits decide the version; `python-semantic-release` tags `vX.Y.Z` on merge to `main`; the tag reaches the apps as `APP_VERSION` at build time. |
| [0003](0003-pre-commit-lint-and-type-checks.md) | Code checks | pre-commit (ruff, mypy, gitleaks, commit messages) locally and in CI; strict mypy, with an exemption list for pre-existing modules. |
| [0004](0004-django-api-in-api-folder.md) | Django API | The GeoDjango API lives in `api/` (apps `common`, `parcels`, `county_config`) with three routed databases: Django's own, the shared parcel data, and the config store. |
| [0005](0005-database-connection-pooling.md) | Connection pooling | Django's psycopg pool on every alias, 5 per worker, 2 workers; FastAPI's timeouts and keepalives; `application_name` set. |
| [0006](0006-data-access-unmanaged-models-raw-sql-first.md) | Data access | Unmanaged models from `inspectdb` for the 7 parcel tables; routes keep their tuned SQL behind a repository, moving to the ORM only where it reads better. |
| [0007](0007-read-only-parcel-data.md) | Read-only parcel data | The parcels connection opens every session read-only, and parcel writes are routed to it so they fail; a dedicated read-only role is the follow-up. |
| [0008](0008-auth-knox-for-private-endpoints.md) | Auth | Public reads stay anonymous and rate limited; Knox tokens and staff login for admin and private endpoints (phase 5); DRF defaults to authenticated. |
| [0009](0009-api-docs-staff-only.md) | API docs | drf-spectacular schema and Swagger UI, staff only in every environment. |
| [0010](0010-config-store-on-existing-table.md) | Config store | `ConfigVersion` maps the existing `config.config_versions` table until cutover, so both backends share one history; Django adopts it afterwards. |
| [0011](0011-contract-parity-front-end-unchanged.md) | Contract parity | Same paths and JSON (no trailing slashes; admin at `/django-admin/`); a route is ported when its contract diff is empty; the front end waits for cutover. |
