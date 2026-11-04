from django.apps import AppConfig


class ParcelsConfig(AppConfig):
    """Read-only models over the assessing and geo tables another pipeline owns (ADR 0006)."""

    name = "parcels"

    def ready(self) -> None:
        """Registers the parcel source settings check (DIC-2802)."""
        from parcels import checks  # noqa: F401
