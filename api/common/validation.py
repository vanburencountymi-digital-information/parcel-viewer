"""Request validation that answers exactly like the FastAPI backend (ADR 0012).

FastAPI validates query and path parameters with Pydantic and returns 422 with
{"detail": [{"type", "loc", "msg", "input", "ctx"?}, ...]}. The port keeps that contract,
so parameters are validated with Pydantic models here too, and the errors are rendered the
same way. Only the parameter source ("query" or "path") is added to each error's location.
"""

from collections.abc import Mapping
from enum import StrEnum
from typing import Any, cast

from pydantic import BaseModel, ValidationError
from rest_framework import status
from rest_framework.exceptions import APIException


class ParamSource(StrEnum):
    QUERY = "query"
    PATH = "path"
    BODY = "body"


class RequestValidationFailed(APIException):
    """A 422 whose body is FastAPI's {"detail": [...]}, rendered by DRF's exception handler."""

    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY

    def __init__(self, errors: list[dict[str, Any]]) -> None:
        # DRF renders a dict detail as-is, but a bare list without the "detail" key.
        self.detail = cast(Any, {"detail": errors})


class HttpError(APIException):
    """FastAPI's HTTPException: {"detail": "<message>"} with the given status."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code


def _fastapi_error(error: Mapping[str, Any], source: ParamSource) -> dict[str, Any]:
    """Takes one Pydantic error and its source. Returns it as FastAPI shows it (no "url")."""
    shown: dict[str, Any] = {
        "type": error["type"],
        "loc": [str(source), *error["loc"]],
        "msg": error["msg"],
        "input": error.get("input"),
    }
    if error.get("ctx"):
        shown["ctx"] = {key: _plain(value) for key, value in error["ctx"].items()}
    return shown


def _plain(value: Any) -> Any:
    """Takes a ctx value. Returns it as JSON can carry it (Pydantic puts exceptions in ctx)."""
    if isinstance(value, str | int | float | bool) or value is None:
        return value
    return str(value)


def validate[Params: BaseModel](
    model: type[Params], data: Mapping[str, Any], source: ParamSource
) -> Params:
    """
    Takes a Pydantic model, the raw parameters, and where they came from.
    Returns the validated model, or raises RequestValidationFailed (422) shaped like FastAPI's.
    A parameter FastAPI saw as missing arrives here as absent, so its input is null.
    """
    try:
        return model.model_validate(dict(data))
    except ValidationError as exc:
        errors = exc.errors(include_url=False)
        for error in errors:
            if error["type"] == "missing":
                error["input"] = None
        raise RequestValidationFailed([_fastapi_error(e, source) for e in errors]) from None


def query_params(request_query: Mapping[str, Any], names: tuple[str, ...]) -> dict[str, Any]:
    """
    Takes a request's query dict and the parameter names a route declares.
    Returns those parameters (last value wins, as FastAPI's scalar parameters do), so
    unknown query parameters are ignored the same way.
    """
    getlist = getattr(request_query, "getlist", None)
    out: dict[str, Any] = {}
    for name in names:
        if name not in request_query:
            continue
        out[name] = getlist(name)[-1] if getlist else request_query[name]
    return out
