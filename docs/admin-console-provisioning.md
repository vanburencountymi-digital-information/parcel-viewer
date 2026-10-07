# Admin Console — production provisioning checklist

The Admin Console's writable config store (DIC-464 / DIC-466) is **fully built in
the application** and verified against a dev database. It stays **dormant** until
the production database and a credential are provisioned. This is the short,
infra-only step that lights it up — everything else is already code.

Until these steps are done, the viewer and console keep working from the baked
manifest (`county-config.js` / `county_configs/*.json`); write endpoints return
`503 Config store not configured`.

## What's needed (≈15 minutes, requires prod DB + Secret Manager access)

1. **Create the schema, table, and writer role** — run the migration against the
   production database as an admin/superuser:
   ```
   psql "$ADMIN_DATABASE_URL" -f backend/migrations/0001_config_store.sql
   ```
   This creates the isolated `config` schema, the `config.config_versions` table,
   and the least-privilege `pv_writer` role (config schema only — no access to
   parcel/assessing data).

2. **Set the writer role's password** (out of band — never commit it):
   ```
   ALTER ROLE pv_writer PASSWORD '<generated-strong-password>';
   ```
   Store the resulting connection string in **Secret Manager**, e.g.
   `postgresql://pv_writer:<password>@<host>:5432/<db>?sslmode=require`.

3. **Wire two env vars** on the parcel-viewer API service (from Secret Manager):
   - `PV_WRITER_DATABASE_URL` → the `pv_writer` connection string (step 2).
   - `PV_ADMIN_TOKEN` → a strong shared token. *Interim* gate on write endpoints
     until real auth (Google SSO) lands — see **DIC-463**. The console sends it as
     the `X-Admin-Token` header.

4. **Redeploy** the API service.

5. **Verify** against the deployed service:
   ```
   curl -s $API/config | jq .name                       # published manifest (JSON)
   curl -s $API/config.js | head -c 60                   # window.COUNTY = {…}
   curl -s -X PUT $API/config/vanburen/draft \
        -H "X-Admin-Token: $PV_ADMIN_TOKEN" -H 'Content-Type: application/json' \
        -d '{"payload": {"name":"Van Buren County"}, "author":"you@vbco"}'
   curl -s -X POST $API/config/vanburen/publish \
        -H "X-Admin-Token: $PV_ADMIN_TOKEN" -d '{}' | jq .version
   curl -s $API/config/vanburen/versions -H "X-Admin-Token: $PV_ADMIN_TOKEN" | jq
   ```

## Security review before go-live
- Confirm `pv_writer` has **no** grants outside the `config` schema (the migration
  grants only there; verify in prod).
- Replace the interim `PV_ADMIN_TOKEN` with real auth + roles (**DIC-463**) before
  exposing the console beyond trusted staff.
- The public read path stays on the read-only role; writes are isolated.

## Staff sign-in on the Django API (DIC-2151, ADR 0013)
The Django port replaces the shared key with per-person staff sign-in and **doesn't
accept the key at all**. The steps above apply to the FastAPI backend until the cutover.
1. **Create a staff user** for each person (in the API container), and grant the
   counties they may edit:
   ```
   python manage.py createsuperuser          # a superuser edits every county
   ```
   Or add users in `/django-admin/`: tick "Staff status", then under "Counties this
   user may edit" add each county key (e.g. `vanburen`). A staff user with no county
   can sign in but edit nothing (403 "No access to county …").
2. **Sign in for a token** and use it instead of the shared key:
   ```
   TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
        -d '{"username":"you","password":"…"}' | jq -r .token)
   curl -s $API/config/vanburen/versions -H "Authorization: Token $TOKEN" | jq
   curl -s -X POST $API/auth/logout -H "Authorization: Token $TOKEN"
   ```
   Tokens expire after `PV_TOKEN_TTL_HOURS` (10). A superuser can revoke any token
   in `/django-admin/` (Knox → Auth tokens).
3. **At cutover** remove `PV_ADMIN_TOKEN` from the service (Django ignores it) and
   give every console user a staff account first.
4. **The Django admin config editor** (ADR 0014) is at `/api/django-admin/` →
   County config → Config versions. It appears only with the writer database
   (`PV_WRITER_DATABASE_URL`, set up at the top of this checklist).
   - Give each editor's account *Can view config version* (history) and *Can change
     config version* (save, publish, roll back). Superusers have both.
   - Behind nginx, set `PV_SCRIPT_NAME=/api` on the API service and add the public
     origin to `CSRF_TRUSTED_ORIGINS` (e.g. `https://gis.dicemi.org`), or the admin's
     links and sign-in form won't work.

## Known follow-ups (application side, not blocking)
- Pool/cache the writer connection so the public `GET /config` hot path doesn't
  open a connection per request (today it does when the store is active; falls
  back to the baked file otherwise).
- Retire / auto-generate the baked `county-config.js` once the store is the
  source of truth in prod.
