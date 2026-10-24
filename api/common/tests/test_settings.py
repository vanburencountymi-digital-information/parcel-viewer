"""Database settings that don't assume compose (ADR 0018, DIC-2554)."""

import os
from unittest.mock import patch

from django.test import SimpleTestCase

from config.settings.base import _database


class DatabaseUrlTests(SimpleTestCase):
    def _config(self, url: str) -> dict:
        with patch.dict(os.environ, {"PV_TEST_DATABASE_URL": url}):
            return _database("PV_TEST_DATABASE_URL")

    def test_url_options_are_kept_beside_ours(self) -> None:
        # A database reached over a public IP needs sslmode=require from its URL.
        config = self._config("postgis://u:p@db.example.org:5432/parcels?sslmode=require")

        self.assertEqual(config["OPTIONS"]["sslmode"], "require")
        self.assertIn("pool", config["OPTIONS"])
        self.assertIn("statement_timeout", config["OPTIONS"]["options"])

    def test_ours_win_over_the_url(self) -> None:
        config = self._config("postgis://u:p@db.example.org/parcels?connect_timeout=60")

        self.assertEqual(config["OPTIONS"]["connect_timeout"], 5)

    def test_a_cloud_sql_socket_is_a_host_path(self) -> None:
        # The Cloud SQL connector's Unix socket, as Cloud Run mounts it (/cloudsql/...).
        config = self._config(
            "postgis://viewer:p%40ss@%2Fcloudsql%2Fproject%3Aus-central1%3Adb-dice/parcels"
        )

        self.assertEqual(config["HOST"], "/cloudsql/project:us-central1:db-dice")
        self.assertEqual(
            (config["NAME"], config["USER"], config["PASSWORD"]), ("parcels", "viewer", "p@ss")
        )
