"""The versioned county config store, mapped onto the existing table (ADR 0010).

config.config_versions was created by backend/migrations/0001 and 0002 and is shared with
the FastAPI backend until cutover, so Django reads and writes it but doesn't migrate it.
"""

from django.db import models
from django.db.models.functions import Now


class ConfigStatus(models.TextChoices):
    DRAFT = "draft"
    PUBLISHED = "published"


class ConfigVersion(models.Model):
    """
    One county config payload. Each county has at most one draft (version is NULL) and any
    number of published versions, numbered from 1. The database enforces both with partial
    unique indexes (config_versions_one_draft, config_versions_unique_version).
    """

    id = models.BigAutoField(primary_key=True)
    county = models.TextField()
    status = models.TextField(choices=ConfigStatus.choices)
    version = models.IntegerField(null=True, blank=True)
    payload = models.JSONField()
    note = models.TextField(null=True, blank=True)
    created_by = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(db_default=Now())

    class Meta:
        managed = False
        db_table = '"config"."config_versions"'
        ordering = ["county", "-version"]

    def __str__(self) -> str:
        label = f"v{self.version}" if self.version is not None else self.status
        return f"{self.county} {label}"
