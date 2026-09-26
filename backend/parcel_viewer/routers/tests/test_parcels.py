from unittest import TestCase
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from parameterized import parameterized
from psycopg import OperationalError
from psycopg.errors import DataError, InternalError_

from app import main


def _pool_raising(exc: Exception) -> MagicMock:
    pool = MagicMock()
    pool.connection.return_value.__enter__.return_value.execute.side_effect = exc
    return pool


DRAWN = {
    "selector": {
        "type": "drawn-polygon",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[-85.91, 42.21], [-85.90, 42.21], [-85.90, 42.22], [-85.91, 42.21]]],
        },
    }
}


class CohortRouteTests(TestCase):
    def setUp(self) -> None:
        self.client = TestClient(main.app)

    def test_invalid_selector_is_a_400(self) -> None:
        response = self.client.post(
            "/cohort",
            json={"selector": {"type": "buffer", "lng": 500, "lat": 42, "distance_ft": 300}},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("longitude", response.json()["detail"])

    @parameterized.expand(
        [
            ("geometry_postgis_rejects", InternalError_("lwgeom: invalid geometry")),
            ("bad_value", DataError("invalid input syntax")),
        ]
    )
    def test_database_rejecting_the_area_is_a_400(self, _name: str, exc: Exception) -> None:
        with (
            patch("parcel_viewer.routers.parcels.pool", _pool_raising(exc)),
            self.assertLogs("parcel_viewer.routers.parcels", level="WARNING"),
        ):
            response = self.client.post("/cohort", json=DRAWN)

        self.assertEqual(response.status_code, 400)
        self.assertNotIn("lwgeom", response.text)  # no database internals to the caller

    def test_lost_database_connection_is_a_503(self) -> None:
        with (
            patch(
                "parcel_viewer.routers.parcels.pool",
                _pool_raising(OperationalError("server closed")),
            ),
            self.assertLogs("parcel_viewer.api", level="WARNING") as logs,
        ):
            response = self.client.post("/cohort", json=DRAWN)

        self.assertEqual(response.status_code, 503)
        self.assertIn("database unavailable", logs.output[-1])


class ParcelsLimitTests(TestCase):
    def test_limit_above_4000_is_rejected(self) -> None:
        response = TestClient(main.app).get(
            "/parcels", params={"bbox": "-85.91,42.21,-85.90,42.22", "limit": 10000}
        )

        self.assertEqual(response.status_code, 422)


def _capturing_pool(rows: list) -> MagicMock:
    pool = MagicMock()
    conn = pool.connection.return_value.__enter__.return_value
    conn.execute.return_value.fetchall.return_value = rows
    return pool


class PublicRouteHardeningTests(TestCase):
    def setUp(self) -> None:
        self.client = TestClient(main.app)

    def test_search_uses_at_most_8_words(self) -> None:
        pool = _capturing_pool([])
        with patch("parcel_viewer.routers.parcels.pool", pool):
            self.client.get("/search", params={"q": " ".join(f"w{i}" for i in range(20))})

        sql, params = pool.connection.return_value.__enter__.return_value.execute.call_args.args
        self.assertNotIn("%w8%", [str(p) for p in params])
        self.assertIn("%w7%", [str(p) for p in params])

    def test_history_hides_operator_and_notes_and_tolerates_null_timestamps(self) -> None:
        row = {
            "event_id": 1,
            "parcel_id": 5,
            "event_type": "split",
            "event_timestamp": None,
            "closure_error": None,
        }
        pool = _capturing_pool([row])
        with patch("parcel_viewer.routers.parcels.pool", pool):
            response = self.client.get("/parcel/5/history")

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["events"][0]["event_timestamp"])
        sql = pool.connection.return_value.__enter__.return_value.execute.call_args.args[0]
        self.assertNotIn("operator_id", sql)
        self.assertNotIn("notes", sql)

    def test_geographies_are_cached(self) -> None:
        from parcel_viewer.routers import parcels

        parcels._geographies_cache.clear()
        pool = _capturing_pool([{"name": "Paw Paw Township"}])
        with patch("parcel_viewer.routers.parcels.pool", pool):
            for _ in range(3):
                response = self.client.get("/cohort/geographies", params={"type": "township"})
                self.assertEqual(
                    response.json()["geographies"], [{"id": None, "name": "Paw Paw Township"}]
                )

        self.assertEqual(pool.connection.call_count, 1)

    def test_config_js_404_does_not_echo_the_county(self) -> None:
        response = self.client.get("/config.js", params={"county": "x*/alert(1)/*"})

        self.assertEqual(response.status_code, 404)
        self.assertNotIn("alert", response.text)

    def test_archived_parcels_are_not_served(self) -> None:
        from parcel_viewer.stores.parcel_store import _PARCEL_SQL

        self.assertIn("archived_at IS NULL", _PARCEL_SQL)
