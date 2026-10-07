"""How many detailed parcel records each client was sent, per county per day (ADR 0015).

Lives in Django's own database. One row per client, county and day, incremented with a
single atomic upsert per response (access.meter), so concurrent requests can't lose counts.
"""

from django.db import models


class DetailUsage(models.Model):
    # A hash of the client (address, key or service name), never the raw address.
    client = models.CharField(max_length=64)
    county = models.SlugField(max_length=64)
    day = models.DateField()
    count = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["client", "county", "day"], name="detail_usage_once"),
        ]
        indexes = [models.Index(fields=["county", "day", "-count"], name="detail_usage_top")]
        verbose_name = "detail usage"
        verbose_name_plural = "detail usage"

    def __str__(self) -> str:
        return f"{self.client} {self.county} {self.day}: {self.count}"
