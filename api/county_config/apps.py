from django.apps import AppConfig


class CountyConfigConfig(AppConfig):
    """The versioned county config store (ADR 0010). Not named `config`: that's the project."""

    name = "county_config"
