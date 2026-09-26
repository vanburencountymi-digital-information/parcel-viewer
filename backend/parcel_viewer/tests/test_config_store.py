"""Config store publishing (DIC-1872): two simultaneous publishes must not produce a
duplicate version; the second is reported as a conflict."""

import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from parcel_viewer.config_store import ConfigStore, PublishConflict


class PublishConflictTests(TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = ConfigStore(dsn=f"sqlite:///{Path(tmp.name, 'config.db').as_posix()}")
        self.store.init_schema()
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

        versions = [v["version"] for v in self.store.list_versions("vanburen")]
        self.assertEqual(sorted(versions), [1])

    def test_rollback_conflict_is_also_reported(self) -> None:
        self.store.publish("vanburen")
        with (
            patch.object(ConfigStore, "_next_version", return_value=1),
            self.assertRaises(PublishConflict),
        ):
            self.store.rollback("vanburen", 1)
