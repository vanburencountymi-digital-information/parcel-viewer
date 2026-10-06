# 10. Config store: map the existing table until cutover

## Status

Accepted (DIC-2148). Changes the plan's "real migrations in its own schema".

## Context

County configs live in `config.config_versions`, created by `backend/migrations/0001` and `0002` (SQL run by hand). The writer login (`pv_writer`) has USAGE but not CREATE on schema `config`, so Django can't migrate there. During the parallel run, both backends must read and write the same configs.

## Decision

- **`ConfigVersion` maps the existing table** (`managed = False`) through the `config_store` alias (`PV_WRITER_DATABASE_URL`). The SQL migrations stay the source of truth for its shape.
- **Locally**, without a writer URL, the alias points at the Django database. Compose creates the table there from the same SQL files.
- **After cutover**, Django takes the table over with a migration that adopts it (`SeparateDatabaseAndState`), and the SQL files are retired.

## Consequences

- Both backends share one config history during the parallel run: no copy, no drift.
- The partial unique indexes (one draft per county; unique published versions) stay database-enforced. The Django code must handle their errors, as `ConfigStore` does today.
