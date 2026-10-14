-- 0001_config_store.sql — writable config store (DIC-464 / DIC-400 / DIC-466)
--
-- Creates an isolated `config` schema, the append-only versions table, and a
-- least-privilege writer role SEPARATE from the public read-only parcels role.
-- Run once against the production database by an admin (see
-- docs/admin-console-provisioning.md). Idempotent where practical.
--
-- The application connects to this schema with the writer role via
-- PV_WRITER_DATABASE_URL (kept in Secret Manager). The public read path never
-- depends on it — GET /config falls back to the baked manifest.

BEGIN;

CREATE SCHEMA IF NOT EXISTS config;

CREATE TABLE IF NOT EXISTS config.config_versions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    county      TEXT        NOT NULL,
    status      TEXT        NOT NULL CHECK (status IN ('draft', 'published')),
    version     INTEGER,                       -- NULL for the working draft
    payload     JSONB       NOT NULL,
    note        TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One working draft per county; fast "latest published" lookups.
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_one_draft
    ON config.config_versions (county) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS config_versions_published
    ON config.config_versions (county, version DESC) WHERE status = 'published';

-- Writer role. Create it with a password OUT OF BAND (do not commit a password):
--   CREATE ROLE pv_writer LOGIN PASSWORD '<from Secret Manager>';
-- This block only ensures the role exists; set/rotate the password separately.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pv_writer') THEN
        CREATE ROLE pv_writer LOGIN;
    END IF;
END
$$;

-- Least privilege: the writer touches ONLY the config schema, nothing else.
GRANT USAGE ON SCHEMA config TO pv_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON config.config_versions TO pv_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA config TO pv_writer;
-- Explicitly DO NOT grant anything on the public/geo/assessing parcel data.

COMMIT;
