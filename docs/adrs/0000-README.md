# Architecture decision records

Short records of significant decisions: what we chose and why. Add one when a decision is hard to reverse or would surprise a newcomer. Update this list in the same change. Older decisions live in `engine/DECISIONS.md`.

| # | Decision | Summary |
|---|---|---|
| [0001](0001-observability-logs-request-ids-sentry.md) | Observability | Request ids on every request and log line; JSON logs to stdout; Sentry (via `ErrorLoggingClient`) only when `SENTRY_DSN` is set; no personal data in logs or error reports. |
| [0002](0002-automatic-semantic-versioning.md) | Versioning | Conventional Commits decide the version; `python-semantic-release` tags `vX.Y.Z` on merge to `main`; the tag reaches the apps as `APP_VERSION` at build time. |
| [0003](0003-pre-commit-lint-and-type-checks.md) | Code checks | pre-commit (ruff, mypy, gitleaks, commit messages) locally and in CI; strict mypy, with an exemption list for pre-existing modules. |
| [0004](0004-django-api-in-api-folder.md) | Django API | The GeoDjango API lives in `api/` (apps `common`, `parcels`, `county_config`, `wms`, `feedback`) with three routed databases: Django's own, the shared parcel data, and the config store. |
| [0005](0005-database-connection-pooling.md) | Connection pooling | Django's psycopg pool on every alias, 5 per worker, 2 workers; FastAPI's timeouts and keepalives; `application_name` set. |
| [0006](0006-data-access-unmanaged-models-raw-sql-first.md) | Data access | Unmanaged models from `inspectdb` for the 7 parcel tables; routes keep their tuned SQL behind a repository, moving to the ORM only where it reads better. |
| [0007](0007-read-only-parcel-data.md) | Read-only parcel data | The parcels connection opens every session read-only, and parcel writes are routed to it so they fail; a dedicated read-only role is the follow-up. |
| [0008](0008-auth-knox-for-private-endpoints.md) | Auth | Public reads stay anonymous and rate limited; Knox tokens and staff login for admin and private endpoints (phase 5); DRF defaults to authenticated. |
| [0009](0009-api-docs-staff-only.md) | API docs | drf-spectacular schema and Swagger UI, staff only in every environment. |
| [0010](0010-config-store-on-existing-table.md) | Config store | `ConfigVersion` maps the existing `config.config_versions` table until cutover, so both backends share one history; Django adopts it afterwards. |
| [0011](0011-contract-parity-front-end-unchanged.md) | Contract parity | Same paths and JSON (no trailing slashes; admin at `/django-admin/`); a route is ported when its contract diff is empty; the front end waits for cutover. |
| [0012](0012-request-validation-and-json-parity.md) | Validation and JSON parity | During the port, parameters are validated with Pydantic and errors rendered as FastAPI's 422s; one renderer encodes Decimals and datetimes as FastAPI does; presenters shape responses until routes move to DRF serializers after cutover. |
| [0013](0013-staff-sign-in-knox-tokens.md) | Staff sign-in | `POST /auth/login` gives an active staff user an expiring Knox token; admin routes take it only (the shared key is retired in Django; 403 if not staff or not granted the county, `accounts.CountyAccess`, superusers all); the token's user is the author. |
| [0014](0014-django-admin-config-editor.md) | Config editor | The Django admin edits `ConfigVersion` through the store (history read-only, publish and rollback as actions, editor = author, Django permissions); `PV_SCRIPT_NAME` mounts Django at nginx's `/api/`. |
| [0015](0015-metered-parcel-details-per-county.md) | Data access | Per-county `open`/`protected`; Protected meters a daily budget of detailed parcel records per client (records, not requests), then withholds owner/value fields gently instead of failing; AI access per key via an MCP server; no CAPTCHAs or obfuscation. |
| [0016](0016-mcp-server-for-visitors-ais.md) | MCP server | Proposed: `/mcp` is a plain Django view in MCP's stateless JSON mode (the API runs WSGI); seven read-only, question-sized tools, no list-everything tool, aggregates over 10+ parcels; the same per-key budget and gentle degrade as the viewer; OAuth per connection. |
