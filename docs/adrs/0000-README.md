# Architecture decision records

Short records of significant decisions: what we chose and why. Add one when a decision is hard to reverse or would surprise a newcomer. Update this list in the same change. Older decisions live in `engine/DECISIONS.md`.

| # | Decision | Summary |
|---|---|---|
| [0001](0001-observability-logs-request-ids-sentry.md) | Observability | Request ids on every request and log line; JSON logs to stdout; Sentry (via `ErrorLoggingClient`) only when `SENTRY_DSN` is set; no personal data in logs or error reports. |
| [0002](0002-automatic-semantic-versioning.md) | Versioning | Conventional Commits decide the version; `python-semantic-release` tags `vX.Y.Z` on merge to `main`; the tag reaches the apps as `APP_VERSION` at build time. |
| [0003](0003-pre-commit-lint-and-type-checks.md) | Code checks | pre-commit (ruff, mypy, gitleaks, commit messages) locally and in CI; strict mypy, with an exemption list for pre-existing modules. |
