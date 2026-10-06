"""Shared choices. No magic strings: compare against these, never against literals."""

from enum import StrEnum


class Environment(StrEnum):
    LOCAL = "local"
    TEST = "test"
    STAGING = "staging"
    PRODUCTION = "production"

    @classmethod
    def deployed(cls) -> frozenset["Environment"]:
        """Returns the environments that run on real infrastructure."""
        return frozenset({cls.STAGING, cls.PRODUCTION})


class DatabaseAlias(StrEnum):
    """The three databases the API talks to (ADR 0004)."""

    # Django's own tables (auth, sessions, admin): the only database Django migrates.
    DEFAULT = "default"
    # Assessing and geo tables another pipeline owns. Read-only (ADR 0007).
    PARCELS = "parcels"
    # The existing county config store table, config.config_versions (ADR 0010).
    CONFIG_STORE = "config_store"
