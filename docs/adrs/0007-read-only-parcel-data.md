# 7. Parcel data is read-only, enforced in the database session

## Status

Accepted (DIC-2148). Follow-up: a dedicated read-only database role.

## Context

The plan called for a read-only database role for parcel data. The login the API uses today (`parcel_studio_app`, shared with parcel-studio) can INSERT and UPDATE `geo.parcel_geometry`. A read-only role needs a database admin (Drake).

## Decision

- **The `parcels` connection opens every session read-only** (`-c default_transaction_read_only=on`). Any write fails in Postgres, whatever the code does.
- **The router sends parcel writes to that same read-only connection** instead of letting them fall through to `default`, so a stray `save()` fails loudly rather than landing somewhere else.
- **A dedicated read-only role replaces the shared login** when one exists. The session setting then stays as a second guard.

## Consequences

- Read-only is enforced today, without waiting for the role.
- A test checks the session setting, and was seen to fail with it removed.
- Until the role exists, the credential itself could still write if it leaked; the role is the real fix.
