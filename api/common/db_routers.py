"""Sends each app's models to its database and keeps Django's migrations off the shared ones."""

from typing import Any

from django.db.models import Model

from common.enums import DatabaseAlias

# App label → the database its models live in. Apps not listed use `default`.
APP_DATABASES = {
    "parcels": DatabaseAlias.PARCELS,
    "county_config": DatabaseAlias.CONFIG_STORE,
}


class DatabaseRouter:
    """
    Reads and writes for the parcels and county_config apps go to their own aliases (ADR 0004).
    Writes to parcel data are routed to the parcels alias on purpose: its session is read-only,
    so a stray save fails loudly instead of landing in Django's own database (ADR 0007).
    """

    def _alias_for(self, model: type[Model]) -> str | None:
        return APP_DATABASES.get(model._meta.app_label)

    def db_for_read(self, model: type[Model], **hints: Any) -> str | None:
        """Takes a model. Returns its database alias, or None for Django's default."""
        return self._alias_for(model)

    def db_for_write(self, model: type[Model], **hints: Any) -> str | None:
        """Takes a model. Returns its database alias, or None for Django's default."""
        return self._alias_for(model)

    def allow_relation(self, obj1: Model, obj2: Model, **hints: Any) -> bool | None:
        """Takes two model instances. Returns False across databases; None leaves it to Django."""
        if obj1._state.db and obj2._state.db and obj1._state.db != obj2._state.db:
            return False
        return None

    def allow_migrate(
        self, db: str, app_label: str, model_name: str | None = None, **hints: Any
    ) -> bool:
        """
        Takes a database alias and an app label. Returns whether Django may migrate there.
        Only Django's own tables are migrated, and only in `default`: the parcel tables belong
        to another pipeline, and config.config_versions to its SQL migrations (ADR 0010).
        """
        if app_label in APP_DATABASES:
            return False
        return db == DatabaseAlias.DEFAULT
