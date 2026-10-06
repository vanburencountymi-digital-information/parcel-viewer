"""Request bodies are read as FastAPI's single-model routes read them (recorded from FastAPI)."""

from django.test import SimpleTestCase
from rest_framework.test import APIRequestFactory

from common.validation import RequestValidationFailed, json_body


class JsonBodyTests(SimpleTestCase):
    def setUp(self) -> None:
        self.factory = APIRequestFactory()

    def _body(self, data: str, content_type: str):
        from rest_framework.request import Request

        return json_body(Request(self.factory.post("/x", data, content_type=content_type)))

    def _error(self, data: str, content_type: str = "application/json") -> list:
        with self.assertRaises(RequestValidationFailed) as caught:
            self._body(data, content_type)
        return caught.exception.detail["detail"]  # type: ignore[index]

    def test_json_is_parsed(self) -> None:
        self.assertEqual(self._body('{"a": 1}', "application/json"), {"a": 1})
        self.assertEqual(self._body("[1]", "application/geo+json"), [1])

    def test_no_body_is_fastapis_missing_body(self) -> None:
        self.assertEqual(
            self._error(""),
            [{"type": "missing", "loc": ["body"], "msg": "Field required", "input": None}],
        )

    def test_malformed_json_reports_where(self) -> None:
        self.assertEqual(
            self._error('{"selector": '),
            [
                {
                    "type": "json_invalid",
                    "loc": ["body", 13],
                    "msg": "JSON decode error",
                    "input": {},
                    "ctx": {"error": "Expecting value"},
                }
            ],
        )

    def test_a_non_json_type_is_left_as_text(self) -> None:
        self.assertEqual(self._body('{"a": 1}', "text/plain"), '{"a": 1}')
