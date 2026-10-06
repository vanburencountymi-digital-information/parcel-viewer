"""GET /wms-proxy: federal WMS GetFeatureInfo and GetLegendGraphic, fetched server-side."""

from django.conf import settings
from django.http import HttpResponse
from pydantic import BaseModel
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from common.throttles import check_limits, limits_for
from common.validation import ParamSource, query_params, validate
from wms import proxy

NOT_ALLOWED = "URL not allowed"


class UrlQuery(BaseModel):
    url: str


class WmsProxyView(APIView):
    """
    Public, so rate limited per client (WMS_PROXY_RATE_LIMIT, 45/minute: an active user
    makes about 30-60 a minute, up to 3 overlay calls per map click; DIC-496).
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []  # checked after validation, as before (check_limits)

    def get(self, request: Request) -> HttpResponse | Response:
        """Returns the upstream content, 403 for a URL off the allowlist, or 502 when upstream fails."""
        params = validate(UrlQuery, query_params(request.query_params, ("url",)), ParamSource.QUERY)
        check_limits(request, self, limits_for("wms_proxy", settings.WMS_PROXY_RATE_LIMIT))
        target = proxy.wms_target(params.url)
        if target is None:
            return Response({"error": NOT_ALLOWED}, status=status.HTTP_403_FORBIDDEN)
        fetched = proxy.fetch(target, int(settings.WMS_PROXY_MAX_BYTES))
        if fetched.error:
            return Response({"error": fetched.error}, status=status.HTTP_502_BAD_GATEWAY)
        response = HttpResponse(fetched.content, content_type=fetched.content_type)
        response["X-Content-Type-Options"] = "nosniff"
        return response
