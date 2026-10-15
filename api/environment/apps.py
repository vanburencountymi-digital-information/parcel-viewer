from django.apps import AppConfig


class EnvironmentConfig(AppConfig):
    """Federal environmental layers (FEMA flood zones first) held in our own database (DIC-2412)."""

    name = "environment"
