-- 0002_config_versions_unique_version.sql — one row per published (county, version)
-- (DIC-1872). Two admins publishing at the same moment both computed max(version)+1 and
-- inserted duplicates; this index makes the second insert fail, which the API reports
-- as 409 "reload and try again". Run once by an admin, after 0001. Idempotent.

CREATE UNIQUE INDEX IF NOT EXISTS config_versions_unique_version
    ON config.config_versions (county, version) WHERE status = 'published';
