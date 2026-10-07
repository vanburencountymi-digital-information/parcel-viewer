"""The daily budget of detailed parcel records (ADR 0015).

A *detailed record* is a parcel row carrying owner or valuation fields. Each response is
charged for the rows it carries (records, not requests) with one atomic upsert. Under a
protected policy, rows past the client's budget are sent without those fields, and the
response says so; nothing fails, so no feature breaks.
"""

import datetime
import hashlib
import hmac
import logging
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import connections
from rest_framework.request import Request
from rest_framework.response import Response

from access.models import DetailUsage
from access.policy import AccessPolicy, policy_for
from common.enums import DatabaseAlias

log = logging.getLogger(__name__)

# The fields a budget protects: who owns a parcel, where they get mail, and what it's worth.
# Shapes, PINs, addresses of the property, class, acreage and districts stay public.
DETAIL_FIELDS = frozenset(
    {
        "owner_name",
        "owner_street",
        "owner_city",
        "owner_state",
        "owner_zip",
        "homestead",
        "assessed_value",
        "taxable_value",
        "prev_assessed_value",
        "prev_taxable_value",
        "assessed_value_yr0",
        "assessed_value_yr1",
        "assessed_value_yr2",
        "assessed_value_yr3",
        "assessed_value_yr4",
        "legal_description",
        "ps_legal_description",
        "tax_description",
    }
)
SERVICE_KEY_HEADER = "X-PV-Service-Key"
ALERT_SHARES = (0.5, 1.0)

UPSERT_SQL = f"""
    INSERT INTO {DetailUsage._meta.db_table} (client, county, day, count)
    VALUES (%s, %s, %s, %s)
    ON CONFLICT (client, county, day)
    DO UPDATE SET count = {DetailUsage._meta.db_table}.count + EXCLUDED.count
    RETURNING count
"""


@dataclass(frozen=True)
class Client:
    key: str  # what the counter stores: a hash, never the raw address
    label: str  # what the logs show
    unmetered: bool = False


@dataclass(frozen=True)
class Charge:
    policy: AccessPolicy
    client: Client
    limit: int | None  # None: unmetered
    used: int  # after this response
    allowed: int  # how many of this response's rows keep their details
    resets_at: datetime.datetime


def _hash(value: str) -> str:
    digest = hmac.new(settings.SECRET_KEY.encode(), value.encode(), hashlib.sha256)
    return digest.hexdigest()[:32]


def _service_name(request: Request) -> str | None:
    given = request.headers.get(SERVICE_KEY_HEADER) or ""
    if not given:
        return None
    for name, key in settings.ACCESS_SERVICE_KEYS.items():
        if key and hmac.compare_digest(given.encode(), key.encode()):
            return str(name)
    return None


def client_for(request: Request) -> Client:
    """
    Takes the request. Returns who is charged: signed-in staff and our own services are
    unmetered; anyone else is their address (nginx's X-Real-IP, else the socket address).
    """
    user = getattr(request, "user", None)
    if user is not None and user.is_authenticated and user.is_active and user.is_staff:
        return Client(key=_hash(f"staff:{user.pk}"), label=f"staff:{user}", unmetered=True)
    service = _service_name(request)
    if service:
        return Client(key=_hash(f"service:{service}"), label=f"service:{service}", unmetered=True)
    address = request.headers.get("X-Real-IP") or request.META.get("REMOTE_ADDR", "") or "unknown"
    return Client(key=_hash(f"ip:{address}"), label=address)


def _today_and_reset() -> tuple[datetime.date, datetime.datetime]:
    zone = ZoneInfo(str(settings.ACCESS_TIMEZONE))
    now = datetime.datetime.now(zone)
    tomorrow = (now + datetime.timedelta(days=1)).date()
    return now.date(), datetime.datetime.combine(tomorrow, datetime.time(), tzinfo=zone)


def charge(request: Request, rows: int, policy: AccessPolicy | None = None) -> Charge | None:
    """
    Takes the request and how many detailed records it is about to send. Returns the charge,
    or None when the county isn't metered. Counts with one atomic upsert, so concurrent
    requests share the budget correctly.
    """
    policy = policy or policy_for()
    if not policy.meters or rows <= 0:
        return None
    client = client_for(request)
    day, resets_at = _today_and_reset()
    if client.unmetered:
        return Charge(policy, client, None, 0, rows, resets_at)
    with connections[DatabaseAlias.DEFAULT].cursor() as cursor:
        cursor.execute(UPSERT_SQL, [client.key, policy.county, day, rows])
        used = int(cursor.fetchone()[0])
    before = used - rows
    allowed = rows if not policy.withholds else max(0, min(rows, policy.budget - before))
    for share in ALERT_SHARES:
        mark = policy.budget * share
        if before < mark <= used:
            log.warning(
                "detail budget %d%% used: client=%s county=%s used=%d budget=%d mode=%s",
                int(share * 100), client.label, policy.county, used, policy.budget, policy.mode,
            )  # fmt: skip
    return Charge(policy, client, policy.budget, used, allowed, resets_at)


def withhold(rows: list[dict[str, Any]], allowed: int) -> bool:
    """Takes rows and how many keep their details. Blanks the rest's detail fields; True if any."""
    withheld = False
    for row in rows[allowed:]:
        for field in DETAIL_FIELDS.intersection(row):
            row[field] = None
        withheld = True
    return withheld


def meter_rows(request: Request, rows: list[dict[str, Any]]) -> Charge | None:
    """Takes the request and the rows it will send. Charges for them and withholds past the budget."""
    result = charge(request, len(rows))
    if result is not None and result.allowed < len(rows):
        withhold(rows, result.allowed)
    return result


def finish(response: Response, result: Charge | None, rows: int) -> Response:
    """
    Takes the response, the charge and how many rows it carries. Under a protected policy,
    adds the budget headers, and when details were withheld the `details_withheld` and
    `detail_budget` members, plus the county's terms. Open and observe responses are
    left exactly as they were.
    """
    if result is None or not result.policy.withholds or result.limit is None:
        return response
    remaining = max(0, result.limit - result.used)
    response["X-Detail-Budget-Limit"] = str(result.limit)
    response["X-Detail-Budget-Remaining"] = str(remaining)
    response["X-Detail-Budget-Reset"] = result.resets_at.isoformat()
    if result.allowed < rows and isinstance(response.data, dict):
        response.data["details_withheld"] = True
        response.data["detail_budget"] = {
            "limit": result.limit,
            "used": min(result.used, result.limit),
            "resets_at": result.resets_at.isoformat(),
            "data_url": result.policy.data_url,
            "terms_url": result.policy.terms_url,
        }
    return response
