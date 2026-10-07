"""Daily summary of who was sent the most detailed parcel records, and old-row cleanup (ADR 0015).

    python manage.py detail_usage_report [--day YYYY-MM-DD] [--top 10] [--keep-days 30]

Run once a day (after midnight, county time). Writes one log line per top client, so the
summary lands wherever the logs go (Sentry/Cloud Logging), then deletes rows older than
--keep-days.
"""

import datetime
import logging
from typing import Any

from django.core.management.base import BaseCommand, CommandParser

from access.models import DetailUsage

log = logging.getLogger("access.report")


class Command(BaseCommand):
    help = "Log the top clients by detailed parcel records for a day, and prune old rows."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--day", type=datetime.date.fromisoformat, default=None)
        parser.add_argument("--top", type=int, default=10)
        parser.add_argument("--keep-days", type=int, default=30)

    def handle(self, *args: Any, **options: Any) -> None:
        day = options["day"] or datetime.date.today() - datetime.timedelta(days=1)
        rows = DetailUsage.objects.filter(day=day).order_by("-count")[: options["top"]]
        for rank, row in enumerate(rows, start=1):
            log.info(
                "detail usage %s #%d: client=%s county=%s records=%d",
                day, rank, row.client, row.county, row.count,
            )  # fmt: skip
        cutoff = datetime.date.today() - datetime.timedelta(days=options["keep_days"])
        deleted, _ = DetailUsage.objects.filter(day__lt=cutoff).delete()
        self.stdout.write(f"{day}: {len(rows)} top clients logged; {deleted} old rows pruned")
