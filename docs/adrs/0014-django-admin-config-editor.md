# 14. The Django admin is the staff config editor, served under nginx's /api mount

## Status

Accepted (DIC-2151). Builds on ADR 0010 (config store) and ADR 0013 (staff sign-in).

## Context

Staff edit the county config through the custom admin console, which calls the API's draft, publish, versions and rollback routes. Phase 5 adds the Django admin as an editor that needs no custom code for lists, filters, forms, permissions or an audit trail. Two things stood in the way:

- The store's rules (one draft per county; published versions are append-only; a simultaneous publish is a conflict, not a duplicate) live in `county_config.store`, not in the model, so a plain model admin could break them.
- nginx serves the API at `/api/` and strips the prefix, so the Django admin built its links, form actions and static URLs without it, and nothing worked through nginx.

## Decision

- **`ConfigVersion` gets a model admin that goes through the store.**
  - Published versions are **read-only and can't be deleted**. There's no "add" form.
  - A draft starts from a published version (the "Start a draft from the selected version" action). Its manifest is edited as JSON and must be a non-empty object. Deleting a draft discards it.
  - "Publish the selected drafts" and "Roll back to the selected version" call `ConfigStore.publish` and `rollback`. A conflict is shown as a message.
  - The signed-in user is the author of every draft save, publish and rollback.
- **Django's own permissions decide who may edit.** `view_configversion` shows the history; `change_configversion` allows saving, publishing and rolling back. Superusers have both.
- **Hidden without a writer database.** With no `PV_WRITER_DATABASE_URL`, the editor isn't shown, as the API's admin routes answer 503.
- **`PV_SCRIPT_NAME` sets `FORCE_SCRIPT_NAME`** for deployments behind nginx's `/api/` mount.
  - Django then builds its links and static URLs (`/api/static/…`) with the prefix. Routing is unchanged.
  - Logs keep the path without the mount (`/health`), as FastAPI logs it.
  - The direct port (`:8001`, used by the contract harness) still routes, though Django-made links on it assume the mount.
- **WhiteNoise serves static files from the apps locally** (`WHITENOISE_USE_FINDERS` outside deployed environments). The production image collects them.

## Consequences

- The admin console and the Django admin edit the same store with the same rules. Either can be used until the team decides whether the console's editors stay.
- A deployment behind nginx sets `PV_SCRIPT_NAME=/api` and adds its public origin to `CSRF_TRUSTED_ORIGINS` (nginx forwards `Host` without the port).
- Multi-county permissions (which staff can edit which county) are the next step (DIC-2151 PR 4).
