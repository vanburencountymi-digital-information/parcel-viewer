# 11. Same URLs and JSON; the front end doesn't change during the port

## Status

Accepted (DIC-2148)

## Context

The viewer's front end and its ~190 e2e tests depend on the FastAPI routes exactly. Vue is planned, but changing both sides at once would leave nothing to check the port against.

## Decision

- **The Django API answers the same paths with the same JSON**, including no trailing slashes (`APPEND_SLASH = False`). Django's admin moves to `/django-admin/`, because `/admin/` is the viewer's admin console and `/admin/discover/layers` is an API route.
- **A route is ported when its `tools/api-contract` diff against FastAPI is empty** and its unit contract tests pass.
- **The front end stays as it is** until cutover. Vue comes after, one component at a time (phase 6, separate plan).

## Consequences

- The e2e suite verifies the swap unchanged (DIC-2150).
- Quirks are carried over on purpose, e.g. `/parcels` and `/cohort` have no `ORDER BY`. Changing them is a separate, visible decision.
