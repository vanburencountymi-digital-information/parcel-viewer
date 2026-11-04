"""Source-neutral parcel read errors (docs/parcel-data-api-client-plan.md, section 4).

Whichever source answers (the SQL database or parcel-data-api), a failure reaches the
browser as the same response the database errors give today (ADR 0011):
`common.exceptions.api_exception_handler` maps the first two to its 503 bodies, and the
cohort view maps the third to its 400.
"""


class ParcelSourceError(Exception):
    """Base class for a failed parcel read."""


class ParcelSourceUnavailable(ParcelSourceError):
    """The source is down, refused us, or answered nonsense: 503 "database unavailable"."""


class ParcelSourceBusy(ParcelSourceError):
    """The source is overloaded or timed out: 503 "database busy"."""


class ParcelSourceRejected(ParcelSourceError):
    """The source rejected the caller's input (a cohort area it can't process): a 400."""
