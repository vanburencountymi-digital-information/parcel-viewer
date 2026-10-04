# Runbook

How to deploy, roll back, rotate secrets, and find out what went wrong.

- [Deploying](#deploying)
- [Rolling back](#rolling-back)
- [Rotating secrets](#rotating-secrets)
- [Finding out what went wrong](#finding-out-what-went-wrong)

Every setting is listed in `infra/DEPLOY-CHECKLIST.md`; the system is described in `ARCHITECTURE.md`.

## Deploying

Deploy from a **release tag** on `main`, never from a branch or a dirty checkout. The two deployables are independent; when a release touches both, deploy Map Buddy first (the viewer copes with an old Map Buddy, not the other way round).

**Viewer stack (on the VM):**

```bash
cd <repo checkout on the VM>
git fetch --tags && git checkout vX.Y.Z          # the release you're deploying
git status --short                               # must print nothing
export APP_VERSION=X.Y.Z
docker compose -f infra/docker-compose.prod.yml --env-file .env up --build -d
docker compose -f infra/docker-compose.prod.yml restart martin   # picks up new geo.*_tiles functions
bash infra/smoke-test.sh https://<viewer host>
```

- **Migrations first**, if the release notes list any (`backend/migrations/`). Run them as an admin against the database *before* `up --build`. They're idempotent and additive, so the old code keeps working while you deploy.
- **Check it worked:** the smoke test exits 0; `curl -s https://<host>/api/health` gives `{"status":"ok","db":true}`; the API's `/openapi.json` is a 404 (docs off). A quick look in the browser: select a parcel, open an explainer.
- **Write down the tag you replaced** (`git describe --tags` before checking out): it's your rollback target.

**Map Buddy (Cloud Run):**

```bash
git checkout vX.Y.Z && git status --short        # clean tree; deploy.sh refuses otherwise
bash map-buddy/deploy.sh                          # builds, pushes :<commit>, deploys a new revision
bash infra/smoke-test.sh https://<viewer host>   # includes the Map Buddy checks
```

`deploy.sh` prints the settings it's about to apply. Override any of them for the environment, e.g. `VIEWER_ORIGINS=https://gis.vanburencountymi.gov PARCEL_API_BASE=https://gis.vanburencountymi.gov/api bash map-buddy/deploy.sh`. Settings set by hand in the Cloud Run console (like `SENTRY_DSN`) are left alone.

## Rolling back

**Decide fast.** If the smoke test fails, or errors jump in the logs/Sentry right after a deploy, roll back first and investigate after.

**Viewer stack:** redeploy the previous tag, exactly as above:

```bash
git checkout v<previous> && export APP_VERSION=<previous>
docker compose -f infra/docker-compose.prod.yml --env-file .env up --build -d
bash infra/smoke-test.sh https://<viewer host>
```

**Map Buddy:** switch traffic back to the previous revision (seconds, no rebuild):

```bash
gcloud run revisions list --service map-buddy --region us-central1 --project core-db-475718
gcloud run services update-traffic map-buddy --to-revisions <previous-revision>=100   --region us-central1 --project core-db-475718
```

Or redeploy an older image by its commit tag: `gcloud run deploy map-buddy --image us-central1-docker.pkg.dev/core-db-475718/map-buddy/map-buddy:<old-commit> --region us-central1 --project core-db-475718`. The next `deploy.sh` run sends traffic to the new revision again.

**When the release included a migration:** migrations here are additive, so **leave them in place** when rolling back the code. The older code ignores what it doesn't use:

| Migration | Rolled-back code with it in place | To remove it (only if it's the problem) |
|---|---|---|
| `0001_config_store.sql` (schema `config`, role `pv_writer`) | Unaffected; code before the admin console never reads it. Unset `PV_WRITER_DATABASE_URL` to stop using it. | Don't drop it: it holds the config history. |
| `0002_config_versions_unique_version.sql` (unique index) | Two simultaneous publishes fail with a 500 instead of a 409; nothing is lost. | `DROP INDEX IF EXISTS config.config_versions_unique_version;` |

Any future migration that isn't additive must ship with its own reverse script and a note here.

**A bad configuration** (not code): in the admin console's version history, click **Restore** on the last good version. That publishes a copy of it as a new version; nothing is deleted. The API equivalent is `POST /api/config/<county>/rollback` with `{"version": N}` and the admin token. Viewers pick it up on their next page load. If the config store itself is down, the viewer already serves the baked copy.

## Rotating secrets

Rotate on a schedule, whenever someone with access leaves, and **immediately** if a secret may have leaked (it showed up in a log, a screenshot, a commit, a chat). gitleaks blocks most commits, but assume anything pasted anywhere is leaked.

**Anthropic API key (Map Buddy):**
1. In the Anthropic Console, create a new key (same workspace, so the spend limit still applies).
2. Store it as a new secret version (read from the clipboard or a prompt, never typed into a command line that's saved in history):
   ```bash
   gcloud secrets versions add MAP_BUDDY_ANTHROPIC_API_KEY --data-file=- --project core-db-475718
   ```
3. Make Cloud Run pick it up (a new revision; secrets are read when a revision starts):
   ```bash
   gcloud run services update map-buddy --update-secrets ANTHROPIC_API_KEY=MAP_BUDDY_ANTHROPIC_API_KEY:latest      --region us-central1 --project core-db-475718
   ```
4. Check `GET <map-buddy>/status` shows `"ai_available": true` and one explainer works.
5. **Then** delete the old key in the Anthropic Console, and disable the old secret version (`gcloud secrets versions disable <n> --secret MAP_BUDDY_ANTHROPIC_API_KEY`).
6. Update the local dev `.env` (`MAP_BUDDY_ANTHROPIC_API_KEY`) for anyone who runs the stack.

**Database passwords** (`PV_DATABASE_URL`, `MARTIN_DATABASE_URL`, `PV_WRITER_DATABASE_URL`):
1. Set a new password for the role (Cloud SQL console → Users, or `ALTER ROLE <role> PASSWORD '…'` as an admin). Existing connections stay up; new ones need the new password.
2. Update the URL in the VM's `.env` straight away, then restart only that service: `docker compose -f infra/docker-compose.prod.yml --env-file .env up -d api` (or `martin`).
3. Check: `curl -s https://<host>/api/health` (read role), a map pan loads tiles (Martin), the admin console loads its versions (writer).

Between steps 1 and 2 new connections fail, so do it at a quiet time and quickly; the pools recover by themselves once the service restarts.

**Admin token** (`PV_ADMIN_TOKEN`):
1. Generate one: `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
2. Put it in the VM's `.env`, then `docker compose -f infra/docker-compose.prod.yml --env-file .env up -d api`.
3. Give it to the admins privately (not by email or chat in plain text); the old one stops working at once.

**Others:** the SMTP password (`PV_SMTP_PASSWORD`, then restart `api` and send a test problem report) and the Sentry DSN (create a new client key in Sentry, update Secret Manager / `.env`, redeploy both, revoke the old key). The Google Maps Embed key is public by design; if it's abused, create a new referrer-restricted key, update `integrations.googleMapsEmbedKey` in the admin console, publish, and delete the old key.


## Finding out what went wrong

**Start from the request id.** Every response from the API and Map Buddy has an `X-Request-ID` header. In the browser: DevTools → Network → click the failed request → Headers. Ask testers to include it in bug reports. Every server log line for that request carries the same id, and so does the nginx access line (`rid=`).

**Where the logs are:**

| Service | Where | How to filter |
|---|---|---|
| API (on the VM) | `docker logs <api container>` | `docker logs api 2>&1 \| grep <request-id>` |
| Map Buddy (Cloud Run) | Cloud Console → Cloud Run → map-buddy → **Logs** | `jsonPayload.request_id="<id>"` |
| nginx | `docker logs <web container>` | `grep rid=<id>` |

In the container images, logs are JSON with these fields:
- `severity`, `message`, `service`, `request_id`;
- for access lines: `path`, `status`, `duration_ms`;
- for model calls: `input_tokens`, `output_tokens`, `cache_read_tokens`.

**What the log lines mean:**

| You see | It means |
|---|---|
| `access` line, severity ERROR | A request failed with a 5xx. Look at the lines with the same `request_id` just before it. |
| `database busy: PoolTimeout` / `QueryCanceled` | The database is overloaded or slow; users get "try again". Check DB load and connections. |
| `health check: database unreachable` | The API can't reach the database; `/health` returns 503. |
| `database unavailable: OperationalError` | A DB connection was lost or refused mid-request; the user got a 503 "try again". The pool replaces dead connections by itself. Many in a row = a DB or network outage. |
| `config store unavailable (init failed / read failed); retrying in 30s` | The writer DB (admin config) is down. The viewer keeps working from the baked manifest; admin edits return 503 until it's back. Logged once per 30s. |
| `cohort: database rejected the selector` | Someone's area (Neighborhood Profile) was something PostGIS couldn't process; they got a 400. Worth a look if frequent. |
| `AI quota exceeded for tenant …` | Map Buddy hit its daily limit; users get facts without AI narration. |
| `ai call <purpose>: in=… out=… cache_read=…` | One model call and what it cost. `cache_read` should be large on chat calls; if it's 0 every time, prompt caching is broken. |
| `wms-proxy upstream … returned 5xx` | A federal map service (FEMA, USFWS, NRCS) is down. Not ours; nothing to fix. |
| `browser error: …` | JavaScript failed in a visitor's browser. `browser_page` and `browser_error_source` say where. |

**Sentry** (once `SENTRY_DSN` is set in staging or production) groups the same errors. Filter by the `operation` tag (for example `explain`, `config_store`) or by `request_id`.

**Health checks:**
- `GET /api/health`: 200 `{"db": true}` when healthy, 503 when the database is down.
- `GET <map-buddy>/health`: liveness.
- `GET <map-buddy>/status`: AI availability, cache and quota counts.
- `bash infra/smoke-test.sh <url>` checks all of these, plus request ids.
