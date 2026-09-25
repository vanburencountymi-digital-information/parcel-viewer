# Architecture decision records

Short records of significant decisions: what we chose and why. Add one when a decision is hard to reverse or would surprise a newcomer. Update this list in the same change. Older decisions live in `engine/DECISIONS.md`.

| # | Decision | Summary |
|---|---|---|
| [0001](0001-observability-logs-request-ids-sentry.md) | Observability | Request ids on every request and log line; JSON logs to stdout; Sentry (via `ErrorLoggingClient`) only when `SENTRY_DSN` is set; no personal data in logs or error reports. |
