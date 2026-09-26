import os
from unittest import TestCase
from unittest.mock import ANY, patch

from parcel_viewer.common import request_context
from parcel_viewer.common.error_logging_client import (
    ErrorLoggingClient,
    init_error_monitoring,
    scrub_event,
)


class ErrorLoggingClientTests(TestCase):
    def setUp(self) -> None:
        self.client = ErrorLoggingClient()

    @patch("parcel_viewer.common.error_logging_client.sentry_sdk.capture_exception", autospec=True)
    def test_report_exception_forwards_to_sentry(self, mock_capture) -> None:
        exc = ValueError("boom")

        self.client.report_exception(exc, tags={"operation": "explain"})

        mock_capture.assert_called_once_with(exc, tags={"operation": "explain"})


class InitErrorMonitoringTests(TestCase):
    @patch.dict(os.environ, {"SENTRY_DSN": "", "SENTRY_ENVIRONMENT": ""}, clear=False)
    @patch("parcel_viewer.common.error_logging_client.sentry_sdk.set_tag", autospec=True)
    @patch("parcel_viewer.common.error_logging_client.sentry_sdk.init", autospec=True)
    def test_never_sends_personal_data(self, mock_init, _mock_tag) -> None:
        init_error_monitoring("parcel-api", "1.2.3")

        mock_init.assert_called_once_with(
            dsn="",
            environment=ANY,
            release="1.2.3",
            send_default_pii=False,
            traces_sample_rate=0.0,
            before_send=scrub_event,
        )

    @patch.dict(
        os.environ, {"SENTRY_DSN": "https://key@sentry.example/1", "SENTRY_ENVIRONMENT": "staging"}
    )
    @patch("parcel_viewer.common.error_logging_client.sentry_sdk.set_tag", autospec=True)
    @patch("parcel_viewer.common.error_logging_client.sentry_sdk.init", autospec=True)
    def test_dsn_and_environment_from_env(self, mock_init, mock_tag) -> None:
        init_error_monitoring("map-buddy", "0.1.0")

        kwargs = mock_init.call_args.kwargs
        self.assertEqual(kwargs["dsn"], "https://key@sentry.example/1")
        self.assertEqual(kwargs["environment"], "staging")
        mock_tag.assert_called_once_with("service", "map-buddy")


class ScrubEventTests(TestCase):
    def test_drops_query_strings_cookies_and_bodies(self) -> None:
        event = {
            "request": {
                "url": "https://gis.dicemi.org/api/search?q=SMITH",
                "query_string": "q=SMITH",
                "cookies": {"a": "b"},
                "data": {"details": "my address"},
                "method": "GET",
            }
        }

        scrubbed = scrub_event(event, {})

        self.assertEqual(
            scrubbed["request"], {"url": "https://gis.dicemi.org/api/search", "method": "GET"}
        )

    def test_tags_the_request_id(self) -> None:
        token = request_context._request_id.set("req-12345678")
        try:
            scrubbed = scrub_event({}, {})
        finally:
            request_context._request_id.reset(token)

        self.assertEqual(scrubbed["tags"]["request_id"], "req-12345678")
