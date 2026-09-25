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
            input_tokens=120, output_tokens=45,
            cache_read_input_tokens=9299, cache_creation_input_tokens=0,
        )

        with self.assertLogs("map_buddy.agent", level="INFO") as logs:
            response = agent._create_message("explain", model="claude-x", max_tokens=10, messages=[])

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

        agent._create_message("chat", model="m", max_tokens=5, messages=[{"role": "user", "content": "hi"}])

        mock_get_client.return_value.messages.create.assert_called_once_with(
            model="m", max_tokens=5, messages=[{"role": "user", "content": "hi"}],
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

    @patch("agent._query_soils", autospec=True, side_effect=OSError("soil down"))
    @patch("agent._arcgis_point_query", autospec=True,
           side_effect=OSError("urlopen error https://internal.example:8443/secret"))
    def test_failures_are_generic_to_users_and_logged(self, _mock_arcgis, _mock_soils) -> None:
        with self.assertLogs("map_buddy.agent", level="WARNING") as logs:
            out = agent._query_environment(-85.9, 42.2)

        self.assertEqual(out["flood"], {"error": "service unavailable right now"})
        self.assertEqual(out["wetlands"], {"error": "service unavailable right now"})
        self.assertEqual(out["soil"], {"error": "service unavailable right now"})
        self.assertNotIn("internal.example", str(out))
        self.assertTrue(any("environment lookup failed: flood" in line for line in logs.output))

    @patch("agent._query_environment", autospec=True, side_effect=RuntimeError("socket details"))
    def test_workflow_note_does_not_leak_the_exception(self, _mock_env) -> None:
        note, _cmds = agent._expand_workflow("risk_overview", {"pin": "1"}, {"centroid": [-85.9, 42.2]})

        self.assertNotIn("socket details", note)
