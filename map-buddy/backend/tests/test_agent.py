from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

import agent


def _response(**usage) -> SimpleNamespace:
    return SimpleNamespace(content=[], usage=SimpleNamespace(**usage))


class CreateMessageTests(TestCase):
    @patch("agent._get_client", autospec=True)
    def test_logs_tokens_cache_and_duration(self, mock_get_client) -> None:
        mock_get_client.return_value.messages.create.return_value = _response(
            input_tokens=120,
            output_tokens=45,
            cache_read_input_tokens=9299,
            cache_creation_input_tokens=0,
        )

        with self.assertLogs("map_buddy.agent", level="INFO") as logs:
            response = agent._create_message(
                "explain", model="claude-x", max_tokens=10, messages=[]
            )

        self.assertEqual(response.usage.input_tokens, 120)
        record = logs.records[-1]
        self.assertEqual(record.ai_purpose, "explain")
        self.assertEqual(record.ai_model, "claude-x")
        self.assertEqual(record.input_tokens, 120)
        self.assertEqual(record.output_tokens, 45)
        self.assertEqual(record.cache_read_tokens, 9299)
        self.assertEqual(record.cache_write_tokens, 0)
        self.assertGreaterEqual(record.duration_ms, 0)

    @patch("agent._get_client", autospec=True)
    def test_passes_arguments_through(self, mock_get_client) -> None:
        mock_get_client.return_value.messages.create.return_value = _response()

        agent._create_message(
            "chat", model="m", max_tokens=5, messages=[{"role": "user", "content": "hi"}]
        )

        mock_get_client.return_value.messages.create.assert_called_once_with(
            model="m",
            max_tokens=5,
            messages=[{"role": "user", "content": "hi"}],
        )

    @patch("agent._get_client", autospec=True)
    def test_errors_propagate_to_the_caller(self, mock_get_client) -> None:
        mock_get_client.return_value.messages.create.side_effect = RuntimeError("overloaded")

        with self.assertRaises(RuntimeError):
            agent._create_message("judge", model="m", max_tokens=5, messages=[])


class ChatStreamErrorTests(TestCase):
    @patch("agent._create_message", autospec=True, side_effect=RuntimeError("SDK detail"))
    def test_failure_is_reported_and_the_user_sees_a_clean_message(self, _mock_create) -> None:
        errors = MagicMock()

        events = list(agent.run_chat_stream("hi", [], None, None, errors=errors))

        self.assertEqual(events[-1]["type"], "error")
        self.assertNotIn("SDK detail", events[-1]["message"])
        errors.report_exception.assert_called_once()
        self.assertEqual(errors.report_exception.call_args.kwargs["tags"], {"operation": "chat"})


class EnvironmentLookupErrorTests(TestCase):
    """CodeQL py/stack-trace-exposure (DIC-1880): lookup failures must not put exception
    text (URLs, hostnames, network errors) into what users or the model see."""

    @patch("agent._http_get_json", autospec=True, side_effect=OSError("parcel API down"))
    @patch("agent._query_soils", autospec=True, side_effect=OSError("soil down"))
    @patch(
        "agent._arcgis_point_query",
        autospec=True,
        side_effect=OSError("urlopen error https://internal.example:8443/secret"),
    )
    def test_failures_are_generic_to_users_and_logged(
        self, _mock_arcgis, _mock_soils, _mock_api
    ) -> None:
        with self.assertLogs("map_buddy.agent", level="WARNING") as logs:
            out = agent._query_environment(-85.9, 42.2)

        self.assertEqual(out["flood"], {"error": "service unavailable right now"})
        self.assertEqual(out["wetlands"], {"error": "service unavailable right now"})
        self.assertEqual(out["soil"], {"error": "service unavailable right now"})
        self.assertNotIn("internal.example", str(out))
        self.assertTrue(any("environment lookup failed: flood" in line for line in logs.output))

    @patch("agent._query_environment", autospec=True, side_effect=RuntimeError("socket details"))
    def test_workflow_note_does_not_leak_the_exception(self, _mock_env) -> None:
        note, _cmds = agent._expand_workflow(
            "risk_overview", {"pin": "1"}, {"centroid": [-85.9, 42.2]}
        )

        self.assertNotIn("socket details", note)


class FloodFromParcelApiTests(TestCase):
    """Flood answers come from the parcel API's copy of FEMA's zones (DIC-2412); FEMA's own
    service is asked only while that data isn't loaded."""

    MAPPED = {
        "flood": {
            "status": "mapped",
            "zone": "AE",
            "subtype": "FLOODWAY",
            "in_special_flood_hazard_area": True,
            "base_flood_elevation_ft": 612.4,
        },
        "sources": {"flood": {"effective": "2026-06-10"}},
    }

    @patch("agent._arcgis_point_query", autospec=True)
    @patch("agent._http_get_json", autospec=True, return_value=MAPPED)
    def test_answers_from_the_parcel_api(self, mock_api, mock_fema) -> None:
        out = agent._flood_at(-85.9, 42.2)

        self.assertEqual(out["zone"], "AE")
        self.assertIs(out["in_special_flood_hazard_area"], True)
        self.assertEqual(out["base_flood_elev_ft"], 612.4)
        self.assertIn("2026-06-10", out["source"])
        self.assertEqual(mock_api.call_args.args[0], "/environment?lng=-85.9&lat=42.2")
        mock_fema.assert_not_called()

    @patch("agent._arcgis_point_query", autospec=True)
    @patch("agent._http_get_json", autospec=True, return_value={"flood": {"status": "unmapped"}})
    def test_an_unmapped_point_does_not_ask_fema(self, _mock_api, mock_fema) -> None:
        self.assertIsNone(agent._flood_at(-85.9, 42.2)["zone"])
        mock_fema.assert_not_called()

    @patch(
        "agent._arcgis_point_query", autospec=True, return_value={"FLD_ZONE": "A", "SFHA_TF": "T"}
    )
    @patch("agent._http_get_json", autospec=True, return_value={"flood": {"status": "not_loaded"}})
    def test_falls_back_to_fema_until_the_data_is_loaded(self, _mock_api, _mock_fema) -> None:
        out = agent._flood_at(-85.9, 42.2)

        self.assertEqual(out["zone"], "A")
        self.assertIs(out["in_special_flood_hazard_area"], True)
