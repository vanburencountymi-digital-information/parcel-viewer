"""The writable county config store (DIC-464, DIC-466), ported from backend/parcel_viewer/config_store.py.

Append-only published versions plus one working draft per county, in config.config_versions
(ADR 0010). The public read path never depends on it: when it is unset or failing, readers
get the baked manifest, and after a failure the store is left alone for a backoff period so
viewer loads don't each wait out a timeout (DIC-1872).
"""

import logging
import threading
import time
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction

from common.enums import DatabaseAlias
from county_config.baked import load_baked
from county_config.models import ConfigStatus, ConfigVersion

log = logging.getLogger(__name__)

CONFIG_STORE = DatabaseAlias.CONFIG_STORE
PUBLISHED_NOTE = "Published"
SEEDED_NOTE = "Seeded from baked manifest"
SEEDED_BY = "system"


class PublishConflict(ValueError):
    """Another publish took the same version number at the same moment (DIC-1872)."""


class ConfigStoreUnavailable(RuntimeError):
    """The writer database failed recently; try again after the backoff."""


def is_configured() -> bool:
    """Returns True when a writer database is set (PV_WRITER_DATABASE_URL); gates all writes."""
    return bool(settings.CONFIG_STORE_CONFIGURED)


class StoreBackoff:
    """After a failure, the store isn't tried again for CONFIG_STORE_RETRY_S seconds."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._down_until = 0.0

    def check(self) -> None:
        """Raises ConfigStoreUnavailable while a backoff window is open."""
        if time.monotonic() < self._down_until:
            raise ConfigStoreUnavailable("config store in backoff")

    def mark_down(self, reason: str) -> None:
        """Takes a short reason. Opens the backoff window and logs it once."""
        retry_s = float(settings.CONFIG_STORE_RETRY_S)
        with self._lock:
            self._down_until = time.monotonic() + retry_s
        log.warning(
            "config store unavailable (%s); retrying in %ss", reason, retry_s, exc_info=True
        )

    def reset(self) -> None:
        """Closes any backoff window (tests)."""
        with self._lock:
            self._down_until = 0.0


backoff = StoreBackoff()


class ConfigStore:
    """Reads and writes county configs. Payloads are the manifests as dicts."""

    def _rows(self, county: str, status: ConfigStatus) -> Any:
        return ConfigVersion.objects.using(CONFIG_STORE).filter(county=county, status=status)

    def get_published(self, county: str) -> dict[str, Any] | None:
        """Takes a county. Returns its latest published manifest, or None."""
        return (
            self._rows(county, ConfigStatus.PUBLISHED)
            .order_by("-version")
            .values_list("payload", flat=True)
            .first()
        )

    def get_draft(self, county: str) -> dict[str, Any] | None:
        """Takes a county. Returns its working draft, or the latest published if no draft exists."""
        draft = self._rows(county, ConfigStatus.DRAFT).values_list("payload", flat=True).first()
        if draft is not None:
            return draft
        return self.get_published(county)

    def list_versions(self, county: str) -> list[dict[str, Any]]:
        """
        Takes a county. Returns its published versions, newest first. created_at is str() of
        the timestamp ("2026-10-06 12:00:00+00:00"), as the FastAPI store returned it.
        """
        rows = (
            self._rows(county, ConfigStatus.PUBLISHED)
            .order_by("-version")
            .values("version", "note", "created_by", "created_at")
        )
        return [
            {
                "version": r["version"],
                "note": r["note"],
                "created_by": r["created_by"],
                "created_at": str(r["created_at"]),
            }
            for r in rows
        ]

    def save_draft(self, county: str, payload: dict[str, Any], author: str | None = None) -> None:
        """Takes a county, a manifest and an author. Replaces the county's single working draft."""
        with transaction.atomic(using=CONFIG_STORE):
            self._rows(county, ConfigStatus.DRAFT).delete()
            ConfigVersion.objects.using(CONFIG_STORE).create(
                county=county,
                status=ConfigStatus.DRAFT,
                version=None,
                payload=payload,
                created_by=author,
            )

    def _next_version(self, county: str) -> int:
        """Takes a county. Returns the next published version number."""
        latest = (
            self._rows(county, ConfigStatus.PUBLISHED)
            .order_by("-version")
            .values_list("version", flat=True)
            .first()
        )
        return (latest or 0) + 1

    def _insert_published(
        self, county: str, version: int, payload: dict[str, Any], note: str, author: str | None
    ) -> None:
        """
        Inserts one published row. Two admins publishing at once compute the same next
        version; the database's unique index rejects the second, which is reported as a
        conflict instead of a 500 or a duplicate version (DIC-1872).
        """
        try:
            with transaction.atomic(using=CONFIG_STORE):
                ConfigVersion.objects.using(CONFIG_STORE).create(
                    county=county,
                    status=ConfigStatus.PUBLISHED,
                    version=version,
                    payload=payload,
                    note=note,
                    created_by=author,
                )
        except IntegrityError as exc:
            raise PublishConflict(
                "another version was just published; reload and try again"
            ) from exc

    def publish(self, county: str, author: str | None = None, note: str | None = None) -> int:
        """Takes a county, an author and a note. Publishes the draft as a new version and returns it."""
        draft = self.get_draft(county)
        if draft is None:
            raise ValueError(f"no draft to publish for county {county!r}")
        version = self._next_version(county)
        self._insert_published(county, version, draft, note or PUBLISHED_NOTE, author)
        return version

    def rollback(self, county: str, version: int, author: str | None = None) -> int:
        """
        Takes a county, a published version and an author. Republishes that version's
        manifest as the new latest version (history is never rewritten). Returns the new version.
        """
        payload = (
            self._rows(county, ConfigStatus.PUBLISHED)
            .filter(version=version)
            .values_list("payload", flat=True)
            .first()
        )
        if payload is None:
            raise ValueError(f"version {version} not found for county {county!r}")
        new_version = self._next_version(county)
        self._insert_published(county, new_version, payload, f"Rollback to v{version}", author)
        return new_version

    def seed_if_empty(self, county: str, payload: dict[str, Any]) -> bool:
        """Takes a county and its baked manifest. Publishes it as v1 if nothing is published. Returns True if it did."""
        if self.get_published(county) is not None:
            return False
        ConfigVersion.objects.using(CONFIG_STORE).create(
            county=county,
            status=ConfigStatus.PUBLISHED,
            version=1,
            payload=payload,
            note=SEEDED_NOTE,
            created_by=SEEDED_BY,
        )
        return True


def published_config(county: str, store: ConfigStore | None = None) -> dict[str, Any] | None:
    """
    Takes a county (and a store, injected in tests). Returns the manifest the viewer should
    use: the store's latest published version when it has one, else the baked file. Any
    store failure falls back to the baked file and starts the backoff.
    """
    baked = load_baked(county)
    if not is_configured():
        return baked
    try:
        backoff.check()
        data = (store or ConfigStore()).get_published(county)
        if data is not None:
            return data
    except ConfigStoreUnavailable:
        pass  # logged when the backoff started
    except Exception:  # noqa: BLE001 — the store must never break the public read path
        backoff.mark_down("read failed")
    return baked
