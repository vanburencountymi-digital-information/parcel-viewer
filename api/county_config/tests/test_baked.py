from django.test import SimpleTestCase
from parameterized import parameterized

from county_config.baked import load_baked, safe_county_key
from county_config.discovery import tile_fields


class BakedManifestTests(SimpleTestCase):
    def test_the_default_county_has_a_baked_manifest(self) -> None:
        manifest = load_baked("vanburen")

        self.assertIsNotNone(manifest)
        self.assertIn("name", manifest or {})

    @parameterized.expand(
        [
            ("traversal", "../../settings", "settings"),
            ("absolute", "/etc/passwd", "etcpasswd"),
            ("case", "VanBuren", "vanburen"),
            ("empty", "", ""),
        ]
    )
    def test_keys_are_reduced_to_safe_names(self, _name, key, safe) -> None:
        self.assertEqual(safe_county_key(key), safe)

    def test_unknown_or_empty_keys_have_no_manifest(self) -> None:
        self.assertIsNone(load_baked("nowhere"))
        self.assertIsNone(load_baked("***"))

    def test_path_characters_are_stripped_so_a_key_never_leaves_the_folder(self) -> None:
        # "../vanburen" reduces to "vanburen", as in the FastAPI backend.
        self.assertEqual(load_baked("../vanburen"), load_baked("vanburen"))


class TileFieldsTests(SimpleTestCase):
    def test_reads_the_properties_feeding_st_asmvt(self) -> None:
        definition = (
            "CREATE FUNCTION geo.subdivisions_tiles(z int, x int, y int) RETURNS bytea AS $$ "
            "SELECT ST_AsMVT(t) FROM (SELECT id, sub_name, unit, ST_AsMVTGeom(geom, b) AS geom "
            "FROM geo.subdivisions) t $$"
        )

        self.assertEqual(tile_fields(definition), ["sub_name", "unit"])

    def test_no_mvt_select_means_no_fields(self) -> None:
        self.assertEqual(tile_fields(""), [])
        self.assertEqual(tile_fields("SELECT 1"), [])
