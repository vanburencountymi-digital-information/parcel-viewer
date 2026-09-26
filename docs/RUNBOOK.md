# Runbook

What to do when something goes wrong. Sections for deploy, rollback and key rotation are still to be written (see `docs/READINESS-CHECKLIST.md`, section 6).

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
