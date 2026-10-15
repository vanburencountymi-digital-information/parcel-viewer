"""Flood zones in our own database (DIC-2412): the load, the lookup, the route and the command."""

import io
import json
import tempfile
from datetime import date
from pathlib import Path
from unittest.mock import patch

from django.core.cache import cache
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from rest_framework.test import APIClient

from environment.flood import FloodDataError, flood_at, load_features
from environment.models import DatasetLoad, FloodZone


def square(x: float, y: float, size: float = 0.01) -> dict:
    """A GeoJSON polygon: a square with its south-west corner at (x, y)."""
    return {
        "type": "Polygon",
        "coordinates": [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
    }


def feature(geometry: dict, zone: str = "AE", **props: object) -> dict:
    base = {"FLD_ZONE": zone, "DFIRM_ID": "26159C", "SFHA_TF": "T", "STATIC_BFE": 612.4}
    return {"type": "Feature", "geometry": geometry, "properties": {**base, **props}}


ZONES = [
    feature(square(-86.0, 42.2), "AE", ZONE_SUBTY="FLOODWAY", FLD_AR_ID="26159C_1"),
    feature(
        square(-86.1, 42.2),
        "X",
        SFHA_TF="F",
        STATIC_BFE=-9999,
        ZONE_SUBTY="AREA OF MINIMAL FLOOD HAZARD",
        FLD_AR_ID="26159C_2",
    ),
]


def load(features: list[dict] = ZONES, **kwargs: object) -> DatasetLoad:
    return load_features(
        features,
        source_url="https://example.org/nfhl",
        source_id="26159C",
        effective_date=date(2026, 6, 10),
        **kwargs,
    )


class LoadTests(TestCase):
    def test_loads_the_zones_and_records_where_they_came_from(self) -> None:
        result = load()
        self.assertEqual(result.feature_count, 2)
        self.assertEqual(result.source_id, "26159C")
        z = FloodZone.objects.get(fld_ar_id="26159C_2")
        self.assertEqual((z.zone, z.sfha, z.static_bfe), ("X", False, None))  # -9999 → none
        self.assertEqual(z.geom.geom_type, "MultiPolygon")

    def test_a_new_load_replaces_the_old_zones(self) -> None:
        load()
        load([feature(square(-85.9, 42.3), "A", FLD_AR_ID="26159C_9")])
        self.assertEqual(list(FloodZone.objects.values_list("fld_ar_id", flat=True)), ["26159C_9"])
        self.assertEqual(DatasetLoad.objects.count(), 2)  # the history stays

    def test_a_bad_feature_leaves_the_previous_zones_in_place(self) -> None:
        load()
        with self.assertRaises(FloodDataError):
            load(
                [
                    feature(square(-85.9, 42.3)),
                    {"type": "Feature", "geometry": None, "properties": {}},
                ]
            )
        self.assertEqual(FloodZone.objects.count(), 2)
        self.assertEqual(DatasetLoad.objects.count(), 1)

    def test_nothing_to_load_is_an_error(self) -> None:
        with self.assertRaises(FloodDataError):
            load([])

    def test_repairs_an_invalid_polygon(self) -> None:
        bowtie = {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]}
        load([feature(bowtie)])
        z = FloodZone.objects.get()
        self.assertTrue(z.geom.valid)
        self.assertGreater(z.geom.area, 0)


class LookupTests(TestCase):
    def test_answers_the_zone_at_a_point(self) -> None:
        load()
        answer = flood_at(-85.995, 42.205)
        self.assertEqual(answer.zone.zone, "AE")
        self.assertEqual(answer.load.source_id, "26159C")

    def test_no_zone_outside_the_mapped_area(self) -> None:
        load()
        self.assertIsNone(flood_at(-84.0, 41.0).zone)

    def test_nothing_loaded_says_so(self) -> None:
        answer = flood_at(-85.995, 42.205)
        self.assertIsNone(answer.load)

    def test_where_zones_overlap_the_special_flood_hazard_area_wins(self) -> None:
        load(
            [
                feature(square(-86.0, 42.2), "X", SFHA_TF="F", STATIC_BFE=-9999),
                feature(square(-86.0, 42.2, 0.005), "AE", SFHA_TF="T"),
            ]
        )
        self.assertEqual(flood_at(-85.998, 42.202).zone.zone, "AE")


class RouteTests(TestCase):
    def setUp(self) -> None:
        cache.clear()
        self.addCleanup(cache.clear)
        self.client = APIClient()

    def test_a_mapped_point(self) -> None:
        load()
        r = self.client.get("/environment", {"lng": -85.995, "lat": 42.205})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(
            body["flood"],
            {
                "status": "mapped",
                "zone": "AE",
                "subtype": "FLOODWAY",
                "in_special_flood_hazard_area": True,
                "base_flood_elevation_ft": 612.4,
                "depth_ft": None,
                "vertical_datum": None,
            },
        )
        self.assertEqual(body["sources"]["flood"]["effective"], "2026-06-10")
        self.assertEqual(body["sources"]["flood"]["id"], "26159C")
        self.assertIn("max-age=3600", r["Cache-Control"])

    def test_an_unmapped_point_and_no_data(self) -> None:
        r = self.client.get("/environment", {"lng": -85.995, "lat": 42.205})
        self.assertEqual(r.json()["flood"], {"status": "not_loaded"})
        self.assertIsNone(r.json()["sources"]["flood"])
        load()
        r = self.client.get("/environment", {"lng": -84.0, "lat": 41.0})
        self.assertEqual(r.json()["flood"], {"status": "unmapped"})

    def test_bad_coordinates_are_rejected(self) -> None:
        for params in ({"lng": "x", "lat": 42}, {"lng": -86}, {"lng": -200, "lat": 42}):
            self.assertEqual(self.client.get("/environment", params).status_code, 422, params)


class CommandTests(TestCase):
    def test_loads_a_saved_download_keeping_only_its_county(self) -> None:
        other = feature(square(-87.0, 42.0), DFIRM_ID="26021C")
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "zones.geojson"
            path.write_text(json.dumps({"type": "FeatureCollection", "features": [*ZONES, other]}))
            call_command(
                "load_flood_zones",
                "--dfirm",
                "26159c",
                "--file",
                str(path),
                "--effective",
                "2026-06-10",
                stdout=io.StringIO(),
            )
        self.assertEqual(FloodZone.objects.count(), 2)
        self.assertEqual(DatasetLoad.objects.get().effective_date, date(2026, 6, 10))

    def test_fetches_from_fema_page_by_page(self) -> None:
        pages = [
            {"features": [ZONES[0]], "exceededTransferLimit": True},
            {"features": [ZONES[1]]},
            {"features": [{"attributes": {"EFF_DATE": 1780000000000}}]},  # panels
        ]
        with patch(
            "environment.management.commands.load_flood_zones._get_json", side_effect=pages
        ) as get:
            call_command("load_flood_zones", "--dfirm", "26159C", stdout=io.StringIO())
        self.assertEqual(FloodZone.objects.count(), 2)
        self.assertIn("resultOffset=1", get.call_args_list[1].args[0])
        self.assertIsNotNone(DatasetLoad.objects.get().effective_date)

    def test_nothing_for_that_county_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "zones.geojson"
            path.write_text(json.dumps({"features": ZONES}))
            with self.assertRaises(CommandError):
                call_command(
                    "load_flood_zones",
                    "--dfirm",
                    "99999C",
                    "--file",
                    str(path),
                    stdout=io.StringIO(),
                )
