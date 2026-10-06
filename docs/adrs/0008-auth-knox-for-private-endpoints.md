# 8. Auth: public reads stay open; Knox tokens for admin and private endpoints

## Status

Accepted (DIC-2148). Built in phase 5 (DIC-2151).

## Context

Anyone can view the parcel viewer without signing in. The config admin routes are protected by one shared key (`PV_ADMIN_TOKEN`), an open security item. The plan asked whether Knox should also cover the public read routes.

## Decision

- **Public read routes stay anonymous and rate limited**, as today. Every public endpoint has a throttle (team standard); `/health` shows the pattern.
- **DRF defaults to "authenticated"**, so a new route is private unless it opts out on purpose.
- **django-rest-knox tokens for admin and private endpoints**, and Django staff login for the config admin. The shared admin key is retired in phase 5.
- During the port (phases 3–4), the admin routes keep the shared key so the contract stays identical.

## Consequences

- No change for viewers.
- Knox is added in phase 5, when it's used, not now.
