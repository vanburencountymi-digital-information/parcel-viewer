from datetime import UTC, datetime
from unittest import TestCase

from parameterized import parameterized

from parcel_viewer.stores.parcel_store import roll_year_for_load


class RollYearForLoadTests(TestCase):
    """Which tax roll the assessed-value history ends at, from the data's load date (DIC-1878)."""

    @parameterized.expand(
        [
            ("loaded_after_board_of_review", datetime(2026, 6, 9, tzinfo=UTC), 2026),
            ("loaded_on_april_first", datetime(2027, 4, 1, tzinfo=UTC), 2027),
            ("loaded_in_december", datetime(2026, 12, 31, tzinfo=UTC), 2026),
            ("loaded_in_january_still_last_roll", datetime(2027, 1, 5, tzinfo=UTC), 2026),
            ("loaded_in_march_before_review_ends", datetime(2027, 3, 31, tzinfo=UTC), 2026),
        ]
    )
    def test_roll_year_follows_the_load_date(
        self, _name: str, loaded_at: datetime, expected: int
    ) -> None:
        roll_year = roll_year_for_load(loaded_at)

        self.assertEqual(roll_year, expected)

    def test_unknown_load_date_gives_no_roll_year(self) -> None:
        roll_year = roll_year_for_load(None)

        self.assertIsNone(roll_year)
