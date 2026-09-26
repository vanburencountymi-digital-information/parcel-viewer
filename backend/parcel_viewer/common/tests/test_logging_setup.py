import json
import logging
import os
import sys
from unittest import TestCase
from unittest.mock import patch

from parcel_viewer.common import request_context
from parcel_viewer.common.logging_setup import (
    JsonFormatter,
    RequestIdFilter,
    configure_logging,
    safe_for_log,
)


def _record(message: str = "hello", level: int = logging.INFO, **extra) -> logging.LogRecord:
    record = logging.LogRecord("parcel_viewer.test", level, __file__, 1, message, None, None)
    for key, value in extra.items():
        setattr(record, key, value)
    RequestIdFilter().filter(record)
    return record


class JsonFormatterTests(TestCase):
    def setUp(self) -> None:
        self.formatter = JsonFormatter("parcel-api")

    def test_core_fields(self) -> None:
        entry = json.loads(self.formatter.format(_record("hello", logging.WARNING)))

        self.assertEqual(entry["severity"], "WARNING")
        self.assertEqual(entry["message"], "hello")
        self.assertEqual(entry["service"], "parcel-api")
        self.assertEqual(entry["logger"], "parcel_viewer.test")
        self.assertIn("time", entry)
        self.assertNotIn("request_id", entry)  # outside a request

    def test_includes_request_id_inside_a_request(self) -> None:
        token = request_context._request_id.set("req-12345678")
        try:
            entry = json.loads(self.formatter.format(_record()))
        finally:
            request_context._request_id.reset(token)

        self.assertEqual(entry["request_id"], "req-12345678")

    def test_includes_extra_fields(self) -> None:
        entry = json.loads(self.formatter.format(_record(status=503, path="/parcels")))

        self.assertEqual(entry["status"], 503)
        self.assertEqual(entry["path"], "/parcels")

    def test_includes_traceback(self) -> None:
        try:
            raise ValueError("boom")
        except ValueError:
            record = _record()
            record.exc_info = sys.exc_info()

        entry = json.loads(self.formatter.format(record))

        self.assertIn("ValueError: boom", entry["exception"])


class SafeForLogTests(TestCase):
    def test_line_breaks_cannot_forge_a_log_line(self) -> None:
        self.assertEqual(
            safe_for_log("boom\r\n2026-01-01 INFO fake line"), "boom  2026-01-01 INFO fake line"
        )

    def test_other_control_characters_become_spaces(self) -> None:
        self.assertEqual(safe_for_log("a\x1b[31mb\x00c"), "a [31mb c")

    def test_cut_to_length_and_non_strings_accepted(self) -> None:
        self.assertEqual(safe_for_log("x" * 10, 4), "xxxx")
        self.assertEqual(safe_for_log(None), "None")


class ConfigureLoggingTests(TestCase):
    def tearDown(self) -> None:
        logging.getLogger().handlers[:] = []
        logging.getLogger("uvicorn.access").disabled = False

    @patch.dict(os.environ, {"LOG_FORMAT": "json", "LOG_LEVEL": "warning"})
    def test_json_format_and_level_from_env(self) -> None:
        configure_logging("map-buddy")

        root = logging.getLogger()
        self.assertEqual(len(root.handlers), 1)
        self.assertIsInstance(root.handlers[0].formatter, JsonFormatter)
        self.assertEqual(root.level, logging.WARNING)

    @patch.dict(os.environ, {"LOG_FORMAT": "text"})
    def test_text_format(self) -> None:
        configure_logging("parcel-api")

        self.assertNotIsInstance(logging.getLogger().handlers[0].formatter, JsonFormatter)

    def test_silences_uvicorn_access_log(self) -> None:
        configure_logging("parcel-api")

        self.assertTrue(logging.getLogger("uvicorn.access").disabled)
