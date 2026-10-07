"""The Django admin as the config editor: history stays read-only, changes go through the store."""

import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.db import connections
from django.test import TestCase, override_settings
from django.urls import reverse

from accounts.models import CountyAccess
from common.enums import DatabaseAlias
from county_config.models import ConfigStatus, ConfigVersion
from county_config.store import ConfigStore, PublishConflict
from county_config.tests.test_models import CONFIG_TABLE_DDL
from county_config.tests.test_store import INDEXES_DDL

CHANGELIST = reverse("admin:county_config_configversion_changelist")


def change_url(row: ConfigVersion) -> str:
    return reverse("admin:county_config_configversion_change", args=[row.pk])


def rows(county: str = "vanburen") -> list[tuple[str, int | None, str | None]]:
    """Returns (status, version, created_by) for the county, published newest first, draft last."""
    return [
        (r.status, r.version, r.created_by)
        for r in ConfigVersion.objects.using(DatabaseAlias.CONFIG_STORE)
        .filter(county=county)
        .order_by("status", "-version")
    ]


@override_settings(CONFIG_STORE_CONFIGURED=True)
class ConfigEditorTests(TestCase):
    databases = {DatabaseAlias.DEFAULT, DatabaseAlias.CONFIG_STORE}

    @classmethod
    def setUpTestData(cls) -> None:
        with connections[DatabaseAlias.CONFIG_STORE].cursor() as cursor:
            cursor.execute(CONFIG_TABLE_DDL + INDEXES_DDL)
        cls.editor = get_user_model().objects.create_superuser("editor", password="x" * 20)

    def setUp(self) -> None:
        self.client.force_login(self.editor)
        self.store = ConfigStore()
        self.store.seed_if_empty("vanburen", {"name": "Van Buren v1"})
        self.store.save_draft("vanburen", {"name": "Van Buren draft"}, author="someone")
        self.draft = ConfigVersion.objects.using(DatabaseAlias.CONFIG_STORE).get(
            county="vanburen", status=ConfigStatus.DRAFT
        )
        self.v1 = ConfigVersion.objects.using(DatabaseAlias.CONFIG_STORE).get(
            county="vanburen", version=1
        )

    def _action(self, action: str, *selected: ConfigVersion):
        return self.client.post(
            CHANGELIST,
            {"action": action, "_selected_action": [r.pk for r in selected]},
            follow=True,
        )

    def test_the_changelist_shows_history_and_the_draft(self) -> None:
        response = self.client.get(CHANGELIST)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "v1")
        self.assertContains(response, "draft")

    def test_published_versions_are_read_only(self) -> None:
        page = self.client.get(change_url(self.v1))
        post = self.client.post(change_url(self.v1), {"payload": json.dumps({"name": "x"})})

        self.assertEqual(page.status_code, 200)
        self.assertNotContains(page, 'name="_save"')
        self.assertEqual(post.status_code, 403)
        self.v1.refresh_from_db(using=DatabaseAlias.CONFIG_STORE)
        self.assertEqual(self.v1.payload, {"name": "Van Buren v1"})

    def test_history_cant_be_deleted_or_added_to_by_hand(self) -> None:
        delete = self.client.post(
            reverse("admin:county_config_configversion_delete", args=[self.v1.pk]), {"post": "yes"}
        )
        add = self.client.get(reverse("admin:county_config_configversion_add"))

        self.assertEqual(delete.status_code, 403)
        self.assertEqual(add.status_code, 403)
        self.assertNotContains(self.client.get(CHANGELIST), "delete_selected")

    def test_saving_the_draft_keeps_its_row_and_records_the_editor(self) -> None:
        response = self.client.post(
            change_url(self.draft),
            {"payload": json.dumps({"name": "Edited"}), "_continue": "1"},
        )

        self.assertRedirects(response, change_url(self.draft))
        self.draft.refresh_from_db(using=DatabaseAlias.CONFIG_STORE)
        self.assertEqual(self.draft.payload, {"name": "Edited"})
        self.assertEqual(self.draft.created_by, "editor")

    def test_a_draft_must_be_a_json_object(self) -> None:
        for bad in ("[1, 2]", "{}", "not json"):
            response = self.client.post(change_url(self.draft), {"payload": bad})

            self.assertEqual(response.status_code, 200, bad)  # the form again, with an error
            self.assertTrue(response.context["adminform"].form.errors, bad)
        self.draft.refresh_from_db(using=DatabaseAlias.CONFIG_STORE)
        self.assertEqual(self.draft.payload, {"name": "Van Buren draft"})

    def test_publishing_a_draft_adds_a_version_by_the_editor(self) -> None:
        response = self._action("publish_drafts", self.draft)

        self.assertContains(response, "Published v2 for vanburen")
        self.assertEqual(self.store.get_published("vanburen"), {"name": "Van Buren draft"})
        self.assertIn(("published", 2, "editor"), rows())

    def test_publishing_with_nothing_but_history_selected_publishes_nothing(self) -> None:
        response = self._action("publish_drafts", self.v1)

        self.assertContains(response, "Select a draft to publish")
        self.assertEqual(self.store.list_versions("vanburen")[0]["version"], 1)

    def test_a_publish_conflict_is_reported_not_a_500(self) -> None:
        with patch.object(
            ConfigStore, "publish", side_effect=PublishConflict("reload and try again")
        ):
            response = self._action("publish_drafts", self.draft)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "reload and try again")

    def test_rolling_back_republishes_an_old_version(self) -> None:
        self.store.publish("vanburen", "someone")  # v2 = the draft

        response = self._action("rollback_to_version", self.v1)

        self.assertContains(response, "Republished v1 as v3 for vanburen")
        self.assertEqual(self.store.get_published("vanburen"), {"name": "Van Buren v1"})
        self.assertIn(("published", 3, "editor"), rows())

    def test_rollback_needs_exactly_one_published_version(self) -> None:
        v2 = self.store.publish("vanburen", "someone")
        both = ConfigVersion.objects.using(DatabaseAlias.CONFIG_STORE).filter(
            county="vanburen", status=ConfigStatus.PUBLISHED
        )

        for selected in (list(both), [self.draft]):
            response = self._action("rollback_to_version", *selected)

            self.assertContains(response, "Select exactly one published version")
        self.assertEqual(self.store.list_versions("vanburen")[0]["version"], v2)

    def test_starting_a_draft_copies_a_version_and_links_to_it(self) -> None:
        response = self._action("start_draft", self.v1)

        draft = ConfigVersion.objects.using(DatabaseAlias.CONFIG_STORE).get(
            county="vanburen", status=ConfigStatus.DRAFT
        )
        self.assertEqual(draft.payload, {"name": "Van Buren v1"})
        self.assertEqual(draft.created_by, "editor")
        self.assertContains(response, change_url(draft))

    def test_discarding_the_draft_leaves_history(self) -> None:
        response = self.client.post(
            reverse("admin:county_config_configversion_delete", args=[self.draft.pk]),
            {"post": "yes"},
        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(rows(), [("published", 1, "system")])

    @override_settings(CONFIG_STORE_CONFIGURED=False)
    def test_without_a_writer_database_the_editor_is_hidden(self) -> None:
        index = self.client.get(reverse("admin:index"))
        changelist = self.client.get(CHANGELIST)

        self.assertNotContains(index, "Config versions")
        self.assertEqual(changelist.status_code, 403)


@override_settings(CONFIG_STORE_CONFIGURED=True)
class ConfigEditorPermissionTests(TestCase):
    databases = {DatabaseAlias.DEFAULT, DatabaseAlias.CONFIG_STORE}

    @classmethod
    def setUpTestData(cls) -> None:
        with connections[DatabaseAlias.CONFIG_STORE].cursor() as cursor:
            cursor.execute(CONFIG_TABLE_DDL + INDEXES_DDL)

    def _staff(self, *perms: str, counties: tuple[str, ...] = ("vanburen",)):
        user = get_user_model().objects.create_user("staffer", password="x" * 20, is_staff=True)
        user.user_permissions.set(Permission.objects.filter(codename__in=perms))
        for county in counties:
            CountyAccess.objects.create(user=user, county=county)
        self.client.force_login(user)

    def test_staff_without_permission_cant_see_it(self) -> None:
        self._staff()

        self.assertEqual(self.client.get(CHANGELIST).status_code, 403)

    def test_view_permission_shows_history_but_offers_no_actions(self) -> None:
        self._staff("view_configversion")

        response = self.client.get(CHANGELIST)

        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, "publish_drafts")

    def test_change_permission_can_publish(self) -> None:
        self._staff("view_configversion", "change_configversion")
        store = ConfigStore()
        store.save_draft("vanburen", {"name": "x"}, author="a")
        draft = ConfigVersion.objects.using(DatabaseAlias.CONFIG_STORE).get(status="draft")

        self.client.post(CHANGELIST, {"action": "publish_drafts", "_selected_action": [draft.pk]})

        self.assertEqual(store.list_versions("vanburen")[0]["created_by"], "staffer")

    def test_staff_see_and_change_only_their_counties(self) -> None:
        self._staff("view_configversion", "change_configversion", counties=("vanburen",))
        store = ConfigStore()
        store.save_draft("vanburen", {"name": "mine"}, author="a")
        store.save_draft("kalamazoo", {"name": "theirs"}, author="a")
        theirs = ConfigVersion.objects.using(DatabaseAlias.CONFIG_STORE).get(county="kalamazoo")

        listing = self.client.get(CHANGELIST)
        page = self.client.get(change_url(theirs))
        self.client.post(CHANGELIST, {"action": "publish_drafts", "_selected_action": [theirs.pk]})

        self.assertContains(listing, "vanburen")
        self.assertNotContains(listing, "kalamazoo")
        self.assertEqual(page.status_code, 302)  # not in their list: the admin says it's gone
        self.assertEqual(store.list_versions("kalamazoo"), [])

    def test_non_staff_are_sent_to_sign_in(self) -> None:
        user = get_user_model().objects.create_user("viewer", password="x" * 20)
        self.client.force_login(user)

        response = self.client.get(CHANGELIST)

        self.assertEqual(response.status_code, 302)
        self.assertIn("/login/", response["Location"])
