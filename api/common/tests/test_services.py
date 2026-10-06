from django.test import SimpleTestCase, TestCase

from common.enums import DatabaseAlias
from common.services import HealthService


class HealthServiceTests(SimpleTestCase):
    def test_ok_when_every_database_answers(self) -> None:
        service = HealthService(ping=lambda alias: True, aliases=["a", "b"])

        self.assertTrue(service.check().ok)

    def test_not_ok_when_any_database_is_down(self) -> None:
        service = HealthService(ping=lambda alias: alias != "b", aliases=["a", "b"])

        self.assertFalse(service.check().ok)

    def test_checks_the_parcel_database_by_default(self) -> None:
        checked: list[str] = []

        def ping(alias: str) -> bool:
            checked.append(alias)
            return True

        HealthService(ping=ping).check()

        self.assertEqual(checked, [DatabaseAlias.PARCELS])


class HealthServiceDatabaseTests(TestCase):
    databases = {DatabaseAlias.DEFAULT, DatabaseAlias.PARCELS}

    def test_a_real_ping_reaches_the_test_database(self) -> None:
        self.assertTrue(HealthService().check().ok)
