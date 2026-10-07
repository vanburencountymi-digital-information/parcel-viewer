# 13. Staff sign-in: Knox tokens for the admin routes, shared key until cutover

## Status

Accepted (DIC-2151). Builds on ADR 0008. **Updated (DIC-2151 PR 4):** the shared key is retired in Django (no `PV_ADMIN_SHARED_KEY`; the admin routes take staff tokens only) and access is per county; see "Retired key and county access" below.

## Context

The config admin routes are guarded by one shared key (`PV_ADMIN_TOKEN`, header `X-Admin-Token`). Everyone who has it looks the same, it can't be revoked for one person, and a draft's author is whatever name the console sends. ADR 0008 chose django-rest-knox for the admin and private routes. Production still runs the FastAPI backend until the parallel run and cutover (DIC-2150), and the FastAPI-era console only knows the shared key.

## Decision

- **Staff sign in for a token.** `POST /auth/login` takes `{"username", "password"}` for an active **staff** user and returns a Knox token, sent as `Authorization: Token <token>`. Only the token's hash is stored. `GET /auth/me` names the token's user; `POST /auth/logout` revokes that one token.
- **Tokens expire** after `PV_TOKEN_TTL_HOURS` (10 by default, a working day) and aren't refreshed by use. One user holds at most `PV_TOKENS_PER_USER` live tokens (5); signing in past that drops the oldest.
- **One answer for every refused sign-in.** A wrong password, an unknown or inactive user, and a non-staff user all get the same 401, so the route never says which usernames exist. Sign-in has its own rate limit per client address (`THROTTLE_LOGIN`, 10/min) on top of nginx's.
- **The admin routes take a staff token or the shared key.** A signed-in user who isn't staff gets 403. While `PV_ADMIN_SHARED_KEY` is on (the default), the shared key still works, so the contract harness and the FastAPI-era console keep working. A token that's present but bad is a 401 even with the key, so a broken token never slips through.
- **The author is the signed-in user.** With a token, drafts, publishes and rollbacks are recorded under the token's username; the body's `author` only counts with the shared key.
- **Retiring the key** in Django means turning `PV_ADMIN_SHARED_KEY` off, then removing the code path (DIC-2151). Retiring it in production lands with the cutover.

## Retired key and county access (DIC-2151 PR 4)

- **The Django API no longer accepts the shared key.** The admin routes take a staff token only. Without one the answer is 401 "Staff sign-in required." `PV_ADMIN_TOKEN` is gone from the Django settings and its compose service. The FastAPI backend in production keeps the key until the cutover, and the console still sends `window.PV_ADMIN_TOKEN` when signed out, for FastAPI.
- **Access is per county.** `accounts.CountyAccess` lists the counties each staff user may edit, and is granted on the user's page in the Django admin.
  - **Superusers** edit every county.
  - **Other staff** edit only the counties granted to them, so a new account edits nothing until granted one.
  - **The API:** a staff user without the county gets 403 "No access to county '…'." That covers draft, publish, versions, rollback, and discovery for the `county` asked for.
  - **The Django editor:** each user sees and changes only their counties.
- **The contract harness** sends the key to FastAPI and a staff token (`PV_STAFF_TOKEN`) to Django. The admin refusals compare status only, because their wording differs by design.

## Consequences

- Staff users, tokens and sessions live in Django's own `default` database, which needs a production home (DIC-590, Drake).
- Staff users are created with `manage.py createsuperuser`, or in the Django admin by a superuser; Knox tokens can be revoked there too.
- The admin console signs in from its sidebar and keeps the token in sessionStorage (closing the tab signs out). It still sends `window.PV_ADMIN_TOKEN` when signed out, for the FastAPI backend.
