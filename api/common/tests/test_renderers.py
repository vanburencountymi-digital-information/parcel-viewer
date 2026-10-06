import datetime
import decimal

from django.test import SimpleTestCase
from parameterized import parameterized

from common.renderers import FastApiCompatibleJSONRenderer, fastapi_decimal


class FastApiDecimalTests(SimpleTestCase):
    @parameterized.expand(
        [
            ("integral", decimal.Decimal("100"), 100, int),
            ("integral_exponent", decimal.Decimal("1E+2"), 100, int),
            ("fraction", decimal.Decimal("0.25"), 0.25, float),
            ("trailing_zero", decimal.Decimal("1.0"), 1.0, float),
        ]
    )
    def test_matches_fastapi_decimal_encoder(self, _name, value, expected, kind) -> None:
        result = fastapi_decimal(value)

        self.assertEqual(result, expected)
        self.assertIs(type(result), kind)


class RendererTests(SimpleTestCase):
    def test_renders_compact_json_like_fastapi(self) -> None:
        data = {
            "homestead": decimal.Decimal("100"),
            "at": datetime.datetime(2027, 2, 10, tzinfo=datetime.UTC),
            "name": "Paw Paw",
        }

        body = FastApiCompatibleJSONRenderer().render(data)

        self.assertEqual(
            body,
            b'{"homestead":100,"at":"2027-02-10T00:00:00+00:00","name":"Paw Paw"}',
        )
