from django.test import SimpleTestCase, TestCase, override_settings

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

    @override_settings(PARCEL_SOURCE="api")
    def test_with_parcel_data_api_it_asks_the_api_not_the_database(self) -> None:
        for answer in (True, False):
            with self.subTest(answer):
                service = HealthService(
                    ping=lambda alias: self.fail("pinged a database"),
                    source_ping=lambda answer=answer: answer,
                )

                self.assertEqual(service.check().ok, answer)


class HealthServiceDatabaseTests(TestCase):
    databases = {DatabaseAlias.DEFAULT, DatabaseAlias.PARCELS}

    def test_a_real_ping_reaches_the_test_database(self) -> None:
        self.assertTrue(HealthService().check().ok)
