"""Which counties a user may edit (DIC-2151), and where staff grant them."""

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import TestCase
from django.urls import reverse
from parameterized import parameterized

from accounts.models import CountyAccess, can_edit_county, editable_counties


def make_user(username: str = "u", **flags: bool):
    return get_user_model().objects.create_user(username, password="x" * 20, **flags)


class CountyAccessTests(TestCase):
    def test_a_superuser_edits_every_county(self) -> None:
        root = make_user(is_staff=True, is_superuser=True)

        self.assertTrue(can_edit_county(root, "anywhere"))
        self.assertIsNone(editable_counties(root))

    def test_staff_edit_only_the_counties_granted_to_them(self) -> None:
        staffer = make_user(is_staff=True)
        CountyAccess.objects.create(user=staffer, county="vanburen")

        self.assertTrue(can_edit_county(staffer, "vanburen"))
        self.assertFalse(can_edit_county(staffer, "kalamazoo"))
        self.assertEqual(editable_counties(staffer), {"vanburen"})

    def test_new_staff_edit_nothing_until_granted_a_county(self) -> None:
        staffer = make_user(is_staff=True)

        self.assertFalse(can_edit_county(staffer, "vanburen"))
        self.assertEqual(editable_counties(staffer), set())

    @parameterized.expand(
        [
            ("not_staff", {"is_staff": False}),
            ("inactive", {"is_staff": True, "is_active": False}),
        ]
    )
    def test_a_grant_needs_an_active_staff_account(self, _name, flags) -> None:
        user = make_user(**flags)
        CountyAccess.objects.create(user=user, county="vanburen")

        self.assertFalse(can_edit_county(user, "vanburen"))

    def test_a_county_is_granted_once_per_user(self) -> None:
        staffer = make_user(is_staff=True)
        CountyAccess.objects.create(user=staffer, county="vanburen")

        with self.assertRaises(IntegrityError):
            CountyAccess.objects.create(user=staffer, county="vanburen")


class UserAdminTests(TestCase):
    def test_the_user_page_grants_counties(self) -> None:
        root = make_user("root", is_staff=True, is_superuser=True)
        staffer = make_user("staffer", is_staff=True)
        self.client.force_login(root)
        url = reverse("admin:auth_user_change", args=[staffer.pk])

        page = self.client.get(url)

        self.assertContains(page, "Counties this user may edit")
