"""County config routes: the published manifest, the base map style, the config store and layer discovery.

The admin routes take a staff user's Knox token, or the shared key until the cutover
(ADR 0013), and keep FastAPI's order: auth first, then the store, then the body.
"""

import json
import logging
import time
from typing import Any

from django.conf import settings
from django.http import HttpResponse
from knox.auth import TokenAuthentication
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from common.validation import HttpError, ParamSource, json_body, query_params, validate
from county_config.auth import author, require_admin, require_writer
from county_config.baked import load_baked
from county_config.discovery import discover_layers
from county_config.params import CountyQuery, DraftBody, PublishBody, RollbackBody
from county_config.store import PublishConflict, published_config
from county_config.style import MAP_STYLE

log = logging.getLogger(__name__)

JAVASCRIPT = "application/javascript"
# Never echo the county into a script body: "*/" in it would end the comment (DIC-1872).
UNKNOWN_COUNTY_SCRIPT = "/* Parcel Viewer: unknown county */"
DISCOVERY_FAILED = "layer discovery failed"
_discovery_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


class OpenView(APIView):
    """No Django auth: these routes are public."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "parcel_read"


def _county(request: Request) -> str:
    """Takes the request. Returns its `county` query parameter, or the default county."""
    params = query_params(request.query_params, ("county",))
    return validate(CountyQuery, params, ParamSource.QUERY).county


class StyleView(OpenView):
    def get(self, request: Request) -> Response:
        """Returns the MapLibre base style."""
        return Response(MAP_STYLE)


class CountyConfigView(OpenView):
    def get(self, request: Request) -> Response:
        """Returns the county's published manifest as JSON, or 404 {"error": ...}."""
        county = _county(request)
        data = published_config(county)
        if data is None:
            return Response(
                {"error": f"Unknown county: {county}"}, status=status.HTTP_404_NOT_FOUND
            )
        return Response(data)


class CountyConfigScriptView(OpenView):
    def get(self, request: Request) -> HttpResponse:
        """
        Returns the manifest as a script that sets window.COUNTY. The viewer loads it after
        its baked county-config.js, so it overrides when reachable and the baked copy stands
        in when it isn't.
        """
        data = published_config(_county(request))
        if data is None:
            return HttpResponse(
                UNKNOWN_COUNTY_SCRIPT, content_type=JAVASCRIPT, status=status.HTTP_404_NOT_FOUND
            )
        body = "window.COUNTY = " + json.dumps(data, ensure_ascii=False) + ";"
        response = HttpResponse(body, content_type=JAVASCRIPT)
        response["Cache-Control"] = "no-cache"
        return response


class AdminView(OpenView):
    """Guarded in the view by require_admin, which sees the Knox token's user (ADR 0013)."""

    authentication_classes = [TokenAuthentication]
    throttle_scope = "admin"


class DiscoverLayersView(AdminView):
    def get(self, request: Request) -> Response:
        """Returns the spatial layers Martin can serve, for Admin Console registration (DIC-502)."""
        require_admin(request)
        county = _county(request)
        cached = _discovery_cache.get(county)
        if cached and time.monotonic() - cached[0] < float(settings.DISCOVERY_CACHE_S):
            return Response({"layers": cached[1]})
        try:
            layers = discover_layers(county)
        except Exception:  # noqa: BLE001 — answered as a 500 with an empty list, as before
            log.exception("layer discovery failed")
            return Response(
                {"error": DISCOVERY_FAILED, "layers": []},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        _discovery_cache[county] = (time.monotonic(), layers)
        return Response({"layers": layers})


class DraftView(AdminView):
    def get(self, request: Request, county: str) -> Response:
        """Returns the working draft, else the latest published, else the baked manifest, else {}."""
        store = require_writer(request)
        return Response(store.get_draft(county) or load_baked(county) or {})

    def put(self, request: Request, county: str) -> Response:
        """Replaces the draft. A county with nothing published is first seeded from its baked file."""
        store = require_writer(request)
        body = validate(DraftBody, json_body(request), ParamSource.BODY)
        baked = load_baked(county)
        if baked:
            store.seed_if_empty(county, baked)
        store.save_draft(county, body.payload, author(request, body.author))
        return Response({"ok": True})


class PublishView(AdminView):
    def post(self, request: Request, county: str) -> Response:
        """Publishes the draft as a new version: 409 if another publish won, 400 if nothing to publish."""
        store = require_writer(request)
        body = validate(PublishBody, json_body(request), ParamSource.BODY)
        baked = load_baked(county)
        if baked:
            store.seed_if_empty(county, baked)
        try:
            version = store.publish(county, author(request, body.author), body.note)
        except PublishConflict as exc:
            raise HttpError(status.HTTP_409_CONFLICT, str(exc)) from exc
        except ValueError as exc:
            raise HttpError(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        return Response({"ok": True, "version": version})


class VersionsView(AdminView):
    def get(self, request: Request, county: str) -> Response:
        """Returns the county's published versions, newest first."""
        store = require_writer(request)
        return Response({"versions": store.list_versions(county)})


class RollbackView(AdminView):
    def post(self, request: Request, county: str) -> Response:
        """Republishes an earlier version as the newest: 404 if that version doesn't exist."""
        store = require_writer(request)
        body = validate(RollbackBody, json_body(request), ParamSource.BODY)
        try:
            version = store.rollback(county, body.version, author(request, body.author))
        except PublishConflict as exc:
            raise HttpError(status.HTTP_409_CONFLICT, str(exc)) from exc
        except ValueError as exc:
            raise HttpError(status.HTTP_404_NOT_FOUND, str(exc)) from exc
        return Response({"ok": True, "version": version})
