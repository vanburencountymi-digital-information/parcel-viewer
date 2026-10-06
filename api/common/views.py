from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from common.serializers import HealthSerializer
from common.services import HealthService


class HealthView(APIView):
    """Liveness/readiness probe. Public by design, so it is rate limited."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [AnonRateThrottle]

    @extend_schema(responses=HealthSerializer)
    def get(self, request: Request) -> Response:
        """Returns 200 when the parcel database answers, 503 when it doesn't."""
        report = HealthService().check()
        http_status = status.HTTP_200_OK if report.ok else status.HTTP_503_SERVICE_UNAVAILABLE
        return Response(HealthSerializer.from_report(report).data, status=http_status)
