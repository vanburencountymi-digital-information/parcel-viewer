# 9. API docs: drf-spectacular, staff only

## Status

Accepted (DIC-2148)

## Context

The FastAPI docs are off unless `PV_API_DOCS=1` (DIC-1855), because public docs advertise every route. The team boilerplate uses drf-spectacular.

## Decision

- **drf-spectacular** generates the schema (`/schema`) and Swagger UI (`/docs`).
- **Both require a staff user** (`SERVE_PERMISSIONS = IsAdminUser`), in every environment.

## Consequences

- Docs stay off the public internet without an environment switch.
- A test checks that anonymous requests to both are refused.
