"""The Django admin as the county config editor (DIC-2151): draft, publish, history, rollback.

Every change goes through the same rules as the API (county_config.store, ADR 0010):
published versions are history and never change or disappear; each county has one working
draft; publishing and rolling back add a new version, so two editors publishing at once
get a conflict instead of a duplicate. The signed-in staff user is the author.
"""

from typing import Any

from django import forms
from django.contrib import admin, messages
from django.db.models import QuerySet
from django.db.models.functions import Now
from django.http import HttpRequest
from django.urls import reverse
from django.utils.html import format_html

from county_config import store
from county_config.models import ConfigStatus, ConfigVersion
from county_config.store import ConfigStore, PublishConflict

ADMIN_NOTE = "Published from the Django admin"


def _author(request: HttpRequest) -> str:
    return str(request.user.get_username())


class DraftForm(forms.ModelForm):
    """Edits a draft's manifest as JSON. The manifest must be a JSON object."""

    class Meta:
        model = ConfigVersion
        fields = ["payload"]
        widgets = {
            "payload": forms.Textarea(
                attrs={"rows": 30, "cols": 100, "style": "font-family: monospace"}
            )
        }

    def clean_payload(self) -> dict[str, Any]:
        payload = self.cleaned_data["payload"]
        if not isinstance(payload, dict) or not payload:
            raise forms.ValidationError("The manifest must be a non-empty JSON object.")
        return payload


@admin.register(ConfigVersion)
class ConfigVersionAdmin(admin.ModelAdmin):
    form = DraftForm
    list_display = ["county", "label", "note", "created_by", "created_at"]
    list_filter = ["county", "status"]
    search_fields = ["county", "note", "created_by"]
    ordering = ["county", "status", "-version"]
    readonly_fields = ["county", "status", "version", "note", "created_by", "created_at"]
    actions = ["publish_drafts", "start_draft", "rollback_to_version"]

    @admin.display(description="Version", ordering="version")
    def label(self, obj: ConfigVersion) -> str:
        return f"v{obj.version}" if obj.version is not None else "draft"

    # Visible only with a writer database (PV_WRITER_DATABASE_URL); without one there is no
    # store to edit, as the API's admin routes answer 503.
    def has_module_permission(self, request: HttpRequest) -> bool:
        return store.is_configured() and super().has_module_permission(request)

    def has_view_permission(self, request: HttpRequest, obj: Any = None) -> bool:
        return store.is_configured() and super().has_view_permission(request, obj)

    # Drafts start from a published version (the "Start a draft" action), never from a
    # blank form, and published versions are read-only history.
    def has_add_permission(self, request: HttpRequest) -> bool:
        return False

    def has_change_permission(self, request: HttpRequest, obj: Any = None) -> bool:
        if obj is not None and obj.status != ConfigStatus.DRAFT:
            return False
        return store.is_configured() and super().has_change_permission(request, obj)

    def has_delete_permission(self, request: HttpRequest, obj: Any = None) -> bool:
        # Deleting a draft discards it; history is never deleted. Without a row (the list's
        # bulk delete, which couldn't tell the two apart) it's refused, so it isn't offered.
        if obj is None or obj.status != ConfigStatus.DRAFT:
            return False
        return super().has_delete_permission(request, obj)

    def get_readonly_fields(self, request: HttpRequest, obj: Any = None) -> list[str]:
        if obj is not None and obj.status != ConfigStatus.DRAFT:
            return [*self.readonly_fields, "payload"]
        return list(self.readonly_fields)

    def save_model(self, request: HttpRequest, obj: ConfigVersion, form: Any, change: bool) -> None:
        """Saves the draft in place (same row, so "Save and continue" works), as its author now."""
        ConfigVersion.objects.using(store.CONFIG_STORE).filter(
            pk=obj.pk, status=ConfigStatus.DRAFT
        ).update(payload=obj.payload, created_by=_author(request), created_at=Now())

    @admin.action(description="Publish the selected drafts", permissions=["change"])
    def publish_drafts(self, request: HttpRequest, queryset: QuerySet[ConfigVersion]) -> None:
        drafts = queryset.filter(status=ConfigStatus.DRAFT)
        if not drafts.exists():
            self.message_user(request, "Select a draft to publish.", messages.WARNING)
            return
        for draft in drafts:
            try:
                version = ConfigStore().publish(draft.county, _author(request), ADMIN_NOTE)
            except PublishConflict as exc:
                self.message_user(
                    request, f"Not published for {draft.county}: {exc}", messages.ERROR
                )
                continue
            self.message_user(
                request, f"Published v{version} for {draft.county}.", messages.SUCCESS
            )

    @admin.action(description="Start a draft from the selected version", permissions=["change"])
    def start_draft(self, request: HttpRequest, queryset: QuerySet[ConfigVersion]) -> None:
        picked = self._one_published(request, queryset)
        if picked is None:
            return
        ConfigStore().save_draft(picked.county, picked.payload, _author(request))
        draft = (
            ConfigVersion.objects.using(store.CONFIG_STORE)
            .filter(county=picked.county, status=ConfigStatus.DRAFT)
            .first()
        )
        url = reverse("admin:county_config_configversion_change", args=[draft.pk]) if draft else ""
        self.message_user(
            request,
            format_html(
                'Started a draft for {} from v{} (it replaced any earlier draft). <a href="{}">Edit it</a>.',
                picked.county,
                picked.version,
                url,
            ),
            messages.SUCCESS,
        )

    @admin.action(description="Roll back to the selected version", permissions=["change"])
    def rollback_to_version(self, request: HttpRequest, queryset: QuerySet[ConfigVersion]) -> None:
        picked = self._one_published(request, queryset)
        if picked is None or picked.version is None:
            return
        try:
            version = ConfigStore().rollback(picked.county, picked.version, _author(request))
        except PublishConflict as exc:
            self.message_user(
                request, f"Not rolled back for {picked.county}: {exc}", messages.ERROR
            )
            return
        self.message_user(
            request,
            f"Republished v{picked.version} as v{version} for {picked.county}.",
            messages.SUCCESS,
        )

    def _one_published(
        self, request: HttpRequest, queryset: QuerySet[ConfigVersion]
    ) -> ConfigVersion | None:
        """Returns the one published version selected, or None after telling the user why."""
        rows = list(queryset[:2])
        if len(rows) != 1 or rows[0].status != ConfigStatus.PUBLISHED:
            self.message_user(request, "Select exactly one published version.", messages.WARNING)
            return None
        return rows[0]
