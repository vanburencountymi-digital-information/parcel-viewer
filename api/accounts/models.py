"""Which counties a staff user may edit: the groundwork for more than one county (DIC-2151).

Superusers edit every county. Any other staff user edits only the counties granted to them
here, so a new account can edit nothing until someone grants it a county. Lives in Django's
own database, beside the users.
"""

from typing import Any

from django.conf import settings
from django.db import models


class CountyAccess(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="county_access"
    )
    # The county key used in the config routes and the store (e.g. "vanburen").
    county = models.SlugField(max_length=64)

    class Meta:
        ordering = ["county"]
        verbose_name = "county access"
        verbose_name_plural = "county access"
        constraints = [
            models.UniqueConstraint(fields=["user", "county"], name="county_access_once"),
        ]

    def __str__(self) -> str:
        return f"{self.user} → {self.county}"


def can_edit_county(user: Any, county: str) -> bool:
    """Takes a user and a county key. Returns True if they may change that county's config."""
    if not (user and user.is_authenticated and user.is_active and user.is_staff):
        return False
    if user.is_superuser:
        return True
    return CountyAccess.objects.filter(user=user, county=county).exists()


def editable_counties(user: Any) -> set[str] | None:
    """Takes a staff user. Returns the counties they may edit, or None for every county."""
    if user.is_superuser:
        return None
    return set(CountyAccess.objects.filter(user=user).values_list("county", flat=True))
