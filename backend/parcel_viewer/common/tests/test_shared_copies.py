from pathlib import Path
from unittest import TestCase

from parameterized import parameterized

_REPO = Path(__file__).resolve().parents[4]
_API_COPY = _REPO / "backend" / "parcel_viewer" / "common"
_MAP_BUDDY_COPY = _REPO / "map-buddy" / "backend" / "common"


class SharedCopiesTests(TestCase):
    """The parcel API and Map Buddy deploy separately, so each has its own copy of the
    shared observability module. Edit one, copy it to the other; this keeps them equal."""

    @parameterized.expand([
        ("__init__.py",),
        ("request_context.py",),
        ("logging_setup.py",),
        ("error_logging_client.py",),
    ])
    def test_copies_are_identical(self, filename: str) -> None:
        api = (_API_COPY / filename).read_text(encoding="utf-8")
        map_buddy = (_MAP_BUDDY_COPY / filename).read_text(encoding="utf-8")

        self.assertEqual(api, map_buddy, f"{filename} differs: copy backend/parcel_viewer/common/ to map-buddy/backend/common/")
