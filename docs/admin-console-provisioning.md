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

## Known follow-ups (application side, not blocking)
- Pool/cache the writer connection so the public `GET /config` hot path doesn't
  open a connection per request (today it does when the store is active; falls
  back to the baked file otherwise).
- Retire / auto-generate the baked `county-config.js` once the store is the
  source of truth in prod.
