# 1. Observability: request ids, JSON logs, Sentry

## Status

Accepted (DIC-1879)

## Context

Before a testing deployment, the parcel API and Map Buddy had about 10 log calls between them, no request ids, no error tracking, and an API `/health` that said "ok" with the database down. A tester's "it broke" couldn't be traced to anything on the server. The team standard (Suggested Architecture Boilerplate; "Production" App Checklist) asks for Sentry wired through a logging module by dependency injection, on staging and production only, plus accessible logs, health monitoring and alerts.

## Decision

- **Request ids.** `RequestContextMiddleware` gives every request an id: the caller's `X-Request-ID` if it's safe (nginx always sends one), otherwise a new one. It's echoed in the response header and stamped on every log line. It writes one access line per request (method, path, status, duration, client IP).
- **Logs to stdout.** JSON in the container images (`LOG_FORMAT=json`, which Cloud Logging indexes) and text locally. `LOG_LEVEL` sets the level. uvicorn's own access log is off, replaced by the one above.
- **Sentry.**
  - `ErrorLoggingClient` is the only module that imports `sentry_sdk`, the same pattern as dice-document-pipeline-api.
  - `init_error_monitoring` runs at startup and does nothing without `SENTRY_DSN`. The DSN is set only in staging and production, from Secret Manager (`dice-sentry-dsn`), with `SENTRY_ENVIRONMENT`.
  - Unhandled errors are reported automatically.
  - Errors the code catches and recovers from also call `report_exception`, tagged with `operation`. The client is injected with FastAPI `Depends`.
- **No personal data leaves the server.** `send_default_pii=False`. `scrub_event` drops query strings (search terms can be owner names), cookies and bodies. Access logs and nginx logs record the path without the query string.
- **Honest health.** The API's `/health` returns 503 when the database is down. Both images have a Docker `HEALTHCHECK` and run as a non-root user.
- **What each kind of failure produces:**
  - DB overload (503) and AI quota hits are **warnings**, not Sentry reports. They are load, not bugs.
  - Failures of the federal map services behind `/wms-proxy` (FEMA, USFWS, NRCS) are logged as warnings and **not** sent to Sentry. They aren't our bugs and would bury real ones.
  - Browser JavaScript errors are posted by `pv-error-beacon.js` to `POST /api/client-errors`, rate limited, and become warning log lines.
  - Map Buddy logs tokens, prompt-cache reads and writes, and duration for every model call.
- **One copy per service.** The API and Map Buddy deploy separately, so `common/` is copied into each. A test fails if the copies differ.

## Consequences

- The Sentry project, the DSN secret, uptime checks and alert routing are infrastructure still to be set up. The code does nothing until they exist.
- JSON logs are harder to read in `docker logs` locally, so the dev compose sets `LOG_FORMAT=text`.
- Browser errors go to logs, not Sentry. Sentry's browser SDK would give stack traces, but it needs a public DSN and a CDN script. We can revisit that if the log lines prove too thin.
- Client IPs are in the access logs, for abuse investigation. Log retention should match county policy.
