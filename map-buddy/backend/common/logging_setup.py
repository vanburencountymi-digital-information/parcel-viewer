"""Log setup (ADR 0001).

Logs go to stdout, one line per record, where Docker and Cloud Logging collect them.
- `LOG_FORMAT=json` (set in the container images): one JSON object per line. Cloud
  Logging reads `severity` and indexes the other fields, so you can filter by
  `request_id`, `status`, `path` and so on.
- `LOG_FORMAT=text` (the default when running outside Docker): easier to read.
- `LOG_LEVEL` sets the minimum level (default INFO).

Every line carries the current request id (see request_context).

This file is kept identical in backend/parcel_viewer/common/ and map-buddy/backend/common/
(a test checks it).
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone

from .request_context import current_request_id

# Attributes every LogRecord has; anything else on a record came from `extra=`.
_STANDARD_ATTRS = set(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {"message", "asctime"}


class RequestIdFilter(logging.Filter):
    """Stamps each record with the current request id ("-" outside a request)."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = current_request_id() or "-"
        return True


class JsonFormatter(logging.Formatter):
    """Formats a record as one JSON line: time, severity, logger, message, service,
    request_id, any `extra=` fields, and the traceback when there is one."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "time": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "severity": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "service": self.service,
        }
        request_id = getattr(record, "request_id", "-")
        if request_id != "-":
            entry["request_id"] = request_id
        for key, value in vars(record).items():
            if key not in _STANDARD_ATTRS and key != "request_id":
                entry[key] = value
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


TEXT_FORMAT = "%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s"


def configure_logging(service: str) -> None:
    """Takes the service name (added to every JSON line). Replaces the root handlers
    with one stdout handler, and turns off uvicorn's own access log, since
    RequestContextMiddleware writes a better one (with the request id)."""
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RequestIdFilter())
    if os.getenv("LOG_FORMAT", "text").lower() == "json":
        handler.setFormatter(JsonFormatter(service))
    else:
        handler.setFormatter(logging.Formatter(TEXT_FORMAT))

    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())

    # uvicorn installs its own handlers before importing the app; route its error
    # logs through ours and silence its access log.
    for name in ("uvicorn", "uvicorn.error"):
        logger = logging.getLogger(name)
        logger.handlers[:] = []
        logger.propagate = True
    logging.getLogger("uvicorn.access").disabled = True
