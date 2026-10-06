"""JSON rendering that matches the FastAPI backend byte for byte (ADR 0012).

DRF and FastAPI both write compact UTF-8 JSON without NaN, but encode two types
differently. FastAPI's `jsonable_encoder` writes a Decimal as an int when it has no
fractional part (so `numeric` 100 is `100`) and keeps a datetime's `+00:00`; DRF writes
`100.0` and `Z`. The viewer reads both, but the contract diff must be empty, so this
encoder follows FastAPI.
"""

import datetime
import decimal
from typing import Any

from rest_framework.renderers import JSONRenderer
from rest_framework.utils.encoders import JSONEncoder


def fastapi_decimal(value: decimal.Decimal) -> int | float:
    """Takes a Decimal. Returns it as FastAPI's decimal_encoder does: int if integral."""
    exponent = value.as_tuple().exponent
    if isinstance(exponent, int) and exponent >= 0:
        return int(value)
    return float(value)


class FastApiCompatibleEncoder(JSONEncoder):
    def default(self, obj: Any) -> Any:
        """Takes a value json can't encode. Returns FastAPI's encoding for the types that differ."""
        if isinstance(obj, decimal.Decimal):
            return fastapi_decimal(obj)
        if isinstance(obj, datetime.datetime | datetime.date | datetime.time):
            return obj.isoformat()
        return super().default(obj)


class FastApiCompatibleJSONRenderer(JSONRenderer):
    encoder_class = FastApiCompatibleEncoder
