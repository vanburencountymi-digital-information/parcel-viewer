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
   psql "$ADMIN_DATABASE_URL" -f api/county_config/sql/0001_config_store.sql
   psql "$ADMIN_DATABASE_URL" -f api/county_config/sql/0002_config_versions_unique_version.sql
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

3. **Set `PV_WRITER_DATABASE_URL`** on the API (`django-api`) to the `pv_writer` connection
   string (step 2), and redeploy it.

4. **Verify** against the deployed service, with a staff sign-in (below):
   ```
   curl -s $API/config | jq .name                       # published manifest (JSON)
   curl -s $API/config.js | head -c 60                   # window.COUNTY = {…}
   curl -s $API/config/vanburen/versions -H "Authorization: Token $TOKEN" | jq
   ```
   Without `PV_WRITER_DATABASE_URL`, the production compose keeps the store in Django's own
   database (`django-db`) instead, which creates the table on its first start.

## Security review before go-live
- Confirm `pv_writer` has **no** grants outside the `config` schema (the migration
  grants only there; verify in prod).
- Staff accounts are per person, with per-county edit access (below). Google SSO
  (**DIC-463**) is still open for later.
- The public read path stays on the read-only role; writes are isolated.

## Staff sign-in (DIC-2151, ADR 0013)
Each person has their own staff account; there is no shared admin key (it went with the
FastAPI backend, DIC-2150).
1. **Create a staff user** for each person (in the API container), and grant the
   counties they may edit:
   ```
   python manage.py createsuperuser          # a superuser edits every county
   ```
   Or add users in `/django-admin/`: tick "Staff status", then under "Counties this
   user may edit" add each county key (e.g. `vanburen`). A staff user with no county
   can sign in but edit nothing (403 "No access to county …").
2. **Sign in for a token:**
   ```
   TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
        -d '{"username":"you","password":"…"}' | jq -r .token)
   curl -s $API/config/vanburen/versions -H "Authorization: Token $TOKEN" | jq
   curl -s -X POST $API/auth/logout -H "Authorization: Token $TOKEN"
   ```
   Tokens expire after `PV_TOKEN_TTL_HOURS` (10). A superuser can revoke any token
   in `/django-admin/` (Knox → Auth tokens).
3. **The Django admin config editor** (ADR 0014) is at `/api/django-admin/` →
   County config → Config versions. It appears only with the writer database
   (`PV_WRITER_DATABASE_URL`, set up at the top of this checklist).
   - Give each editor's account *Can view config version* (history) and *Can change
     config version* (save, publish, roll back). Superusers have both.
   - The production compose already sets `PV_SCRIPT_NAME=/api` and trusts
     `https://<PV_PUBLIC_HOST>` for its forms (`infra/docker-compose.prod.yml`).

## Known follow-ups (application side, not blocking)
- Pool/cache the writer connection so the public `GET /config` hot path doesn't
  open a connection per request (today it does when the store is active; falls
  back to the baked file otherwise).
- Retire / auto-generate the baked `county-config.js` once the store is the
  source of truth in prod.
