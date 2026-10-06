from unittest.mock import patch

from django.test import SimpleTestCase

from common.enums import DatabaseAlias
from parcels import repositories
from parcels.repositories import ParcelRepository, search_sql


class SearchSqlTests(SimpleTestCase):
    def test_every_word_must_match_and_its_value_is_a_parameter(self) -> None:
        sql, params = search_sql(["smith", "main"])

        self.assertEqual(sql.count("pg.parcel_no ILIKE %s OR a.owner_name ILIKE %s"), 2)
        self.assertEqual(params[:4], ["%smith%"] * 4)
        self.assertNotIn("smith", sql)  # never interpolated into the SQL

    def test_a_house_number_ranks_as_a_whole_word(self) -> None:
        _, params = search_sql(["219", "e", "paw"])

        self.assertIn(r"(^|\D)219(\D|$)", params)

    def test_a_word_first_query_has_no_house_number_rank(self) -> None:
        _, params = search_sql(["paw", "paw"])

        self.assertFalse(any("(^|" in str(p) for p in params))


class ParcelSqlTests(SimpleTestCase):
    def test_archived_parcels_are_never_served(self) -> None:
        for sql in (repositories.PARCEL_SQL, repositories.BBOX_SQL, search_sql(["x"])[0]):
            self.assertIn("archived_at IS NULL", sql)

    def test_history_hides_operator_and_notes(self) -> None:
        self.assertNotIn("operator_id", repositories.HISTORY_SQL)
        self.assertNotIn("notes", repositories.HISTORY_SQL)

    def test_street_view_reads_the_address_points_fulladdr_column(self) -> None:
        # The table was reloaded and full_address became fulladdr (DIC-2152).
        self.assertIn("a.fulladdr AS full_address", repositories.STREETVIEW_SQL)


class ParcelRepositoryTests(SimpleTestCase):
    @patch("parcels.repositories.fetch_all", autospec=True, return_value=[])
    def test_reads_go_to_the_read_only_parcels_database(self, mock_fetch_all) -> None:
        ParcelRepository().in_bbox(-86.1, 42.2, -86.0, 42.3, 5)

        alias, _sql, params = mock_fetch_all.call_args.args
        self.assertEqual(alias, DatabaseAlias.PARCELS)
        self.assertEqual(params, [-86.1, 42.2, -86.0, 42.3, 5])
