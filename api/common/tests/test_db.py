from django.test import TestCase

from common.db import fetch_all, fetch_one
from common.enums import DatabaseAlias


class FetchTests(TestCase):
    databases = {DatabaseAlias.DEFAULT, DatabaseAlias.PARCELS}

    def test_rows_are_dicts_and_json_is_parsed_like_fastapis_driver(self) -> None:
        # Django's backend leaves json/jsonb as text; FastAPI's psycopg parsed it (cogo_legs).
        rows = fetch_all(
            DatabaseAlias.PARCELS,
            """SELECT 1 AS id, '{"seq": 1}'::jsonb AS legs, '[1, 2]'::json AS arr,
                      NULL::jsonb AS empty, 'text' AS label""",
        )

        self.assertEqual(
            rows, [{"id": 1, "legs": {"seq": 1}, "arr": [1, 2], "empty": None, "label": "text"}]
        )

    def test_parameters_are_bound_not_interpolated(self) -> None:
        row = fetch_one(DatabaseAlias.PARCELS, "SELECT %s::text AS v", ["'; DROP TABLE x; --"])

        self.assertEqual(row, {"v": "'; DROP TABLE x; --"})

    def test_no_rows_is_none(self) -> None:
        self.assertIsNone(fetch_one(DatabaseAlias.PARCELS, "SELECT 1 WHERE false"))

    def test_the_parcels_connection_refuses_writes(self) -> None:
        from django.db import InternalError, ProgrammingError

        with self.assertRaises((InternalError, ProgrammingError)):
            fetch_all(DatabaseAlias.PARCELS, "CREATE TABLE should_not_exist (id int)")
