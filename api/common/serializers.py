from typing import Any

from rest_framework import serializers

from common.services import HealthReport

HEALTH_OK = "ok"
HEALTH_DEGRADED = "degraded"


class HealthSerializer(serializers.Serializer[dict[str, Any]]):
    """The FastAPI health contract: {"status": "ok"|"degraded", "db": bool}."""

    status = serializers.ChoiceField(choices=[HEALTH_OK, HEALTH_DEGRADED])
    db = serializers.BooleanField()

    @classmethod
    def from_report(cls, report: HealthReport) -> "HealthSerializer":
        """Takes a health report. Returns a serializer holding its public fields."""
        return cls({"status": HEALTH_OK if report.ok else HEALTH_DEGRADED, "db": report.ok})
