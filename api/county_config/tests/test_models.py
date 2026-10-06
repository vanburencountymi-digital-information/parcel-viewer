from django.db import connections
from django.test import TestCase

from common.enums import DatabaseAlias
from county_config.models import ConfigStatus, ConfigVersion

# The table backend/migrations/0001_config_store.sql creates, so the model is tested against
# the real shape. The model is unmanaged (ADR 0010), so the test database doesn't have it.
CONFIG_TABLE_DDL = """
CREATE SCHEMA IF NOT EXISTS config;
CREATE TABLE IF NOT EXISTS config.config_versions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    county      TEXT        NOT NULL,
    status      TEXT        NOT NULL CHECK (status IN ('draft', 'published')),
    version     INTEGER,
    payload     JSONB       NOT NULL,
    note        TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


class ConfigVersionTests(TestCase):
    databases = {DatabaseAlias.DEFAULT, DatabaseAlias.CONFIG_STORE}

    @classmethod
    def setUpTestData(cls) -> None:
        with connections[DatabaseAlias.CONFIG_STORE].cursor() as cursor:
            cursor.execute(CONFIG_TABLE_DDL)

    def test_round_trip_with_database_defaults(self) -> None:
        saved = ConfigVersion.objects.create(
            county="vanburen",
            status=ConfigStatus.PUBLISHED,
            version=3,
            payload={"name": "Van Buren"},
        )

        loaded = ConfigVersion.objects.get(pk=saved.pk)

        self.assertEqual(loaded.payload, {"name": "Van Buren"})
        self.assertIsNotNone(loaded.created_at)
        self.assertEqual(str(loaded), "vanburen v3")

    def test_a_draft_has_no_version(self) -> None:
        draft = ConfigVersion.objects.create(
            county="vanburen", status=ConfigStatus.DRAFT, payload={}
        )

        self.assertIsNone(draft.version)
        self.assertEqual(str(draft), "vanburen draft")
