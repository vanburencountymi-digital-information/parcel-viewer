from django.apps import AppConfig


class ParcelsConfig(AppConfig):
    """Read-only models over the assessing and geo tables another pipeline owns (ADR 0006)."""

    name = "parcels"
