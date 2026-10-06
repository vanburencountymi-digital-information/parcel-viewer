"""The config store against Postgres (ported from backend/parcel_viewer/tests/test_config_store.py
and backend/app/tests/test_config_store_outage.py, DIC-1872)."""

from unittest.mock import MagicMock, patch

from django.db import connections
from django.test import SimpleTestCase, TestCase, override_settings

from common.enums import DatabaseAlias
from county_config import store
from county_config.store import ConfigStore, PublishConflict, published_config
from county_config.tests.test_models import CONFIG_TABLE_DDL

# The partial unique indexes backend/migrations/0001 and 0002 add.
INDEXES_DDL = """
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_one_draft
    ON config.config_versions (county) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_unique_version
    ON config.config_versions (county, version) WHERE status = 'published';
"""


class ConfigStoreTests(TestCase):
    databases = {DatabaseAlias.DEFAULT, DatabaseAlias.CONFIG_STORE}

    @classmethod
    def setUpTestData(cls) -> None:
        with connections[DatabaseAlias.CONFIG_STORE].cursor() as cursor:
            cursor.execute(CONFIG_TABLE_DDL + INDEXES_DDL)

    def setUp(self) -> None:
        self.store = ConfigStore()
        self.store.save_draft("vanburen", {"name": "Van Buren"}, author="a")

    def test_versions_increase(self) -> None:
        self.assertEqual(self.store.publish("vanburen"), 1)
        self.assertEqual(self.store.publish("vanburen"), 2)

    def test_a_simultaneous_publish_is_a_conflict_not_a_duplicate(self) -> None:
        self.store.publish("vanburen")
        # Simulate the race: the second admin computed the same "next" version.
        with (
            patch.object(ConfigStore, "_next_version", return_value=1),
            self.assertRaises(PublishConflict),
        ):
            self.store.publish("vanburen")

        self.assertEqual([v["version"] for v in self.store.list_versions("vanburen")], [1])

    def test_rollback_conflict_is_also_reported(self) -> None:
        self.store.publish("vanburen")
        with (
            patch.object(ConfigStore, "_next_version", return_value=1),
            self.assertRaises(PublishConflict),
        ):
            self.store.rollback("vanburen", 1)

    def test_draft_is_replaced_and_published_as_the_latest(self) -> None:
        self.store.save_draft("vanburen", {"name": "Edited"}, author="b")

        self.assertEqual(self.store.get_draft("vanburen"), {"name": "Edited"})
        self.store.publish("vanburen", author="b", note="Fix label")
        self.assertEqual(self.store.get_published("vanburen"), {"name": "Edited"})
        latest = self.store.list_versions("vanburen")[0]
        self.assertEqual(
            (latest["version"], latest["note"], latest["created_by"]), (1, "Fix label", "b")
        )
        self.assertRegex(latest["created_at"], r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d")  # str(), not ISO

    def test_rollback_republishes_an_old_version_as_the_newest(self) -> None:
        self.store.publish("vanburen")
        self.store.save_draft("vanburen", {"name": "Second"})
        self.store.publish("vanburen")

        new_version = self.store.rollback("vanburen", 1, author="c")

        self.assertEqual(new_version, 3)
        self.assertEqual(self.store.get_published("vanburen"), {"name": "Van Buren"})
        self.assertEqual(self.store.list_versions("vanburen")[0]["note"], "Rollback to v1")

    def test_rollback_to_a_missing_version_is_a_value_error(self) -> None:
        with self.assertRaisesRegex(ValueError, "version 9 not found"):
            self.store.rollback("vanburen", 9)

    def test_seeding_only_happens_once(self) -> None:
        self.assertTrue(self.store.seed_if_empty("ottawa", {"name": "Ottawa"}))
        self.assertFalse(self.store.seed_if_empty("ottawa", {"name": "Other"}))
        self.assertEqual(self.store.get_published("ottawa"), {"name": "Ottawa"})

    def test_publishing_with_nothing_at_all_is_a_value_error(self) -> None:
        with self.assertRaisesRegex(ValueError, "no draft to publish"):
            self.store.publish("nowhere")


@override_settings(CONFIG_STORE_CONFIGURED=True, CONFIG_STORE_RETRY_S=30.0)
class PublishedConfigTests(SimpleTestCase):
    """The public read path never depends on the store (DIC-1872)."""

    def setUp(self) -> None:
        store.backoff.reset()
        self.addCleanup(store.backoff.reset)
        baked = patch("county_config.store.load_baked", return_value={"name": "baked"})
        baked.start()
        self.addCleanup(baked.stop)

    def test_the_stores_published_version_wins(self) -> None:
        fake = MagicMock(spec=ConfigStore)
        fake.get_published.return_value = {"name": "published"}

        self.assertEqual(published_config("vanburen", store=fake), {"name": "published"})

    def test_nothing_published_yet_serves_the_baked_manifest(self) -> None:
        fake = MagicMock(spec=ConfigStore)
        fake.get_published.return_value = None

        self.assertEqual(published_config("vanburen", store=fake), {"name": "baked"})

    def test_a_failing_read_serves_baked_and_backs_off(self) -> None:
        fake = MagicMock(spec=ConfigStore)
        fake.get_published.side_effect = OSError("connection lost")

        with self.assertLogs("county_config.store", level="WARNING") as logs:
            self.assertEqual(published_config("vanburen", store=fake), {"name": "baked"})
        self.assertIn("read failed", logs.output[-1])

        # Inside the backoff: no new attempt, and nothing logged.
        self.assertEqual(published_config("vanburen", store=fake), {"name": "baked"})
        self.assertEqual(fake.get_published.call_count, 1)

    @patch("county_config.store.time.monotonic")
    def test_retries_after_the_backoff(self, mock_clock) -> None:
        mock_clock.return_value = 1000.0
        fake = MagicMock(spec=ConfigStore)
        fake.get_published.side_effect = [OSError("down"), {"name": "back"}]
        with self.assertLogs("county_config.store", level="WARNING"):
            published_config("vanburen", store=fake)

        mock_clock.return_value = 1031.0

        self.assertEqual(published_config("vanburen", store=fake), {"name": "back"})

    @override_settings(CONFIG_STORE_CONFIGURED=False)
    def test_without_a_writer_database_the_store_is_never_touched(self) -> None:
        fake = MagicMock(spec=ConfigStore)

        self.assertEqual(published_config("vanburen", store=fake), {"name": "baked"})
        fake.get_published.assert_not_called()
