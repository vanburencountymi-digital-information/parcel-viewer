from django.apps import AppConfig


class AccessConfig(AppConfig):
    """Per-county data access: the daily budget of detailed parcel records (ADR 0015)."""

    name = "access"
    verbose_name = "Data access"
