from django.test import SimpleTestCase
from pydantic import BaseModel, Field

from common.validation import ParamSource, RequestValidationFailed, query_params, validate


class Params(BaseModel):
    q: str = Field(min_length=2, max_length=100)
    limit: int = Field(10, ge=1, le=50)
    lng: float | None = None


class ValidateTests(SimpleTestCase):
    """Errors must be exactly FastAPI's (recorded from the FastAPI backend by tools/api-contract)."""

    def _errors(self, data: dict, source: ParamSource = ParamSource.QUERY) -> list:
        with self.assertRaises(RequestValidationFailed) as caught:
            validate(Params, data, source)
        self.assertEqual(caught.exception.status_code, 422)
        return caught.exception.detail["detail"]  # type: ignore[index]

    def test_valid_parameters_are_coerced_like_fastapi(self) -> None:
        params = validate(Params, {"q": "ab", "limit": "5", "lng": "-86.1"}, ParamSource.QUERY)

        self.assertEqual((params.q, params.limit, params.lng), ("ab", 5, -86.1))

    def test_too_short_matches_fastapi(self) -> None:
        self.assertEqual(
            self._errors({"q": "a"}),
            [
                {
                    "type": "string_too_short",
                    "loc": ["query", "q"],
                    "msg": "String should have at least 2 characters",
                    "input": "a",
                    "ctx": {"min_length": 2},
                }
            ],
        )

    def test_out_of_range_keeps_the_raw_text_input(self) -> None:
        self.assertEqual(
            self._errors({"q": "ab", "limit": "51"}),
            [
                {
                    "type": "less_than_equal",
                    "loc": ["query", "limit"],
                    "msg": "Input should be less than or equal to 50",
                    "input": "51",
                    "ctx": {"le": 50},
                }
            ],
        )

    def test_a_missing_parameter_has_null_input(self) -> None:
        self.assertEqual(
            self._errors({}),
            [{"type": "missing", "loc": ["query", "q"], "msg": "Field required", "input": None}],
        )

    def test_the_source_prefixes_the_location(self) -> None:
        errors = self._errors({"q": "ab", "limit": "x"}, ParamSource.PATH)

        self.assertEqual(errors[0]["loc"], ["path", "limit"])
        self.assertNotIn("url", errors[0])


class QueryParamsTests(SimpleTestCase):
    def test_keeps_declared_names_and_the_last_repeated_value(self) -> None:
        from django.http import QueryDict

        query = QueryDict("q=first&q=last&other=1")

        self.assertEqual(query_params(query, ("q", "limit")), {"q": "last"})
