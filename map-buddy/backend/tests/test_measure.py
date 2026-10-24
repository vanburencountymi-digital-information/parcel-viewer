import json
from unittest import TestCase
from unittest.mock import patch

import agent
import measure

# Reference numbers from @turf/turf 7.4 with the browser's own formulas
# (map-control-api.js quickParcelInfo / measureArea / measureDistance).
SQUARE = [[-85.91, 42.21], [-85.90, 42.21], [-85.90, 42.22], [-85.91, 42.22]]
TURF_SQUARE = {
    "acres": 226.284,
    "sqft": 9856923,
    "perimeter_ft": 12700,
    "est_dim_long_ft": 3648,
    "est_dim_short_ft": 2702,
}
HOLE = [
    [-85.907, 42.213],
    [-85.903, 42.213],
    [-85.903, 42.217],
    [-85.907, 42.217],
    [-85.907, 42.213],
]
TRIANGLE = [[-85.88, 42.2], [-85.879, 42.2], [-85.879, 42.201], [-85.88, 42.2]]
PATH = [[-85.91, 42.21], [-85.90, 42.21], [-85.90, 42.215]]


class MatchesTurfTests(TestCase):
    def test_polygon_area_perimeter_and_dimensions(self) -> None:
        self.assertEqual(measure.measure_area(SQUARE), TURF_SQUARE)

    def test_an_already_closed_ring_gives_the_same_answer(self) -> None:
        self.assertEqual(measure.measure_area(SQUARE + [SQUARE[0]]), TURF_SQUARE)

    def test_multipolygon_with_a_hole(self) -> None:
        geom = {"type": "MultiPolygon", "coordinates": [[SQUARE + [SQUARE[0]], HOLE], [TRIANGLE]]}

        out = measure.measure_geometry(geom)

        self.assertEqual(out["acres"], 191.21)
        self.assertEqual(out["sqft"], 8329111)
        self.assertEqual(out["perimeter_ft"], 18869)

    def test_path_distance(self) -> None:
        out = measure.measure_distance(PATH)

        self.assertEqual(out["total_ft"], 4526)
        self.assertEqual(out["segments"], 2)
        self.assertEqual(out["longest_segment_ft"], 2702)
        self.assertEqual(out["shortest_segment_ft"], 1824)
        self.assertEqual(out["total_mi"], 0.86)


class CleanPointsTests(TestCase):
    def test_accepts_pairs_and_lng_lat_objects(self) -> None:
        self.assertEqual(
            measure.clean_points([[-85.9, 42.2], {"lng": -85.8, "lat": 42.3}]),
            [[-85.9, 42.2], [-85.8, 42.3]],
        )

    def test_rejects_bad_input(self) -> None:
        for bad in (
            None,
            "x",
            [[-85.9]],
            [["a", 42.2]],
            [[True, 42.2]],
            [[float("nan"), 42.2]],
            [[-200, 42.2]],
            [[0, 0]] * (measure.MAX_POINTS + 1),
        ):
            with self.subTest(bad=str(bad)[:40]):
                self.assertIsNone(measure.clean_points(bad))

    def test_geometry_that_is_not_a_polygon_is_not_measured(self) -> None:
        self.assertIsNone(measure.measure_geometry({"type": "Point", "coordinates": [0, 0]}))
        self.assertIsNone(measure.measure_geometry(None))


SEARCH = {"results": [{"id": 41, "pin": "80-01-001-002-00"}, {"id": 7, "pin": "80-01-001-001-00"}]}
PARCEL = {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [SQUARE + [SQUARE[0]]]}}


def _api(path: str):
    return SEARCH if path.startswith("/search") else PARCEL


class MeasureToolTests(TestCase):
    """The model gets the numbers the user sees (DIC-2434)."""

    @patch("agent._http_get_json", autospec=True, side_effect=_api)
    def test_measure_parcel_looks_up_the_exact_pin(self, mock_api) -> None:
        out = json.loads(agent._measure_tool("measure_parcel", {"pin": "80-01-001-001-00"}, None))

        self.assertEqual(out["pin"], "80-01-001-001-00")
        self.assertEqual(out["acres"], TURF_SQUARE["acres"])
        self.assertEqual(mock_api.call_args.args[0], "/parcel/7")

    @patch("agent._http_get_json", autospec=True, side_effect=_api)
    def test_measure_parcel_defaults_to_the_selected_parcel(self, mock_api) -> None:
        out = json.loads(agent._measure_tool("measure_parcel", {}, {"pin": "8001001001 00"}))

        self.assertEqual(out["sqft"], TURF_SQUARE["sqft"])

    @patch("agent._http_get_json", autospec=True, return_value={"results": []})
    def test_unknown_pin_says_the_numbers_are_unavailable(self, _mock_api) -> None:
        self.assertEqual(
            agent._measure_tool("measure_parcel", {"pin": "nope"}, None), agent._MEASURE_UNREAD
        )

    def test_no_pin_and_no_selection(self) -> None:
        self.assertIn("none is selected", agent._measure_tool("measure_parcel", {}, None))

    @patch("agent._http_get_json", autospec=True, side_effect=OSError("http://internal:8000 down"))
    def test_api_failure_is_generic_and_logged(self, _mock_api) -> None:
        with self.assertLogs("map_buddy.agent", level="WARNING"):
            out = agent._measure_tool("measure_parcel", {"pin": "1"}, None)

        self.assertEqual(out, agent._MEASURE_UNREAD)
        self.assertNotIn("internal", out)

    def test_measure_area_and_distance_need_enough_points(self) -> None:
        self.assertIn(
            "at least 3", agent._measure_tool("measure_area", {"coordinates": PATH[:2]}, None)
        )
        self.assertIn(
            "at least 2", agent._measure_tool("measure_distance", {"coordinates": [[1, 2]]}, None)
        )

    def test_measure_area_and_distance_return_numbers(self) -> None:
        area = json.loads(agent._measure_tool("measure_area", {"coordinates": SQUARE}, None))
        dist = json.loads(agent._measure_tool("measure_distance", {"coordinates": PATH}, None))

        self.assertEqual(area, TURF_SQUARE)
        self.assertEqual(dist["total_ft"], 4526)


def _tool_turn(name: str, inp: dict):
    block = type("B", (), {"type": "tool_use", "id": "t1", "name": name, "input": inp})()
    return type("R", (), {"content": [block], "stop_reason": "tool_use"})()


def _text_turn(text: str):
    block = type("B", (), {"type": "text", "text": text})()
    return type("R", (), {"content": [block], "stop_reason": "end_turn"})()


class ChatLoopTests(TestCase):
    @patch("agent._create_message", autospec=True)
    def test_the_command_still_goes_to_the_browser_and_the_model_gets_numbers(
        self, mock_create
    ) -> None:
        mock_create.side_effect = [
            _tool_turn("measure_area", {"coordinates": SQUARE}),
            _text_turn("About 226 acres."),
        ]

        events = list(agent.run_chat_stream("how big?", [], None, None))

        done = events[-1]
        self.assertEqual(
            done["commands"], [{"type": "measure_area", "payload": {"coordinates": SQUARE}}]
        )
        # messages is one list mutated in place, so the last call sees the full history.
        tool_result = mock_create.call_args.kwargs["messages"][-2]["content"][0]
        self.assertEqual(json.loads(tool_result["content"])["acres"], TURF_SQUARE["acres"])

    @patch("agent._http_get_json", autospec=True, side_effect=_api)
    @patch("agent._query_environment", autospec=True, return_value={"flood": {}})
    def test_analyze_parcel_workflow_note_carries_the_measurement(self, _env, _api_mock) -> None:
        note, cmds = agent._expand_workflow(
            "analyze_parcel", {"pin": "80-01-001-001-00"}, {"centroid": [-85.9, 42.2]}
        )

        self.assertIn("measure_parcel", [c["type"] for c in cmds])
        self.assertIn('"acres": 226.284', note)
