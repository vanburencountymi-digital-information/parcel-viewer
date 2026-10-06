from django.conf import settings
from django.contrib.auth.models import User
from django.test import SimpleTestCase
from parameterized import parameterized

from common.db_routers import DatabaseRouter
from common.enums import DatabaseAlias
from county_config.models import ConfigVersion
from parcels.models import AddressPoint, AssessingParcel, ParcelGeometry


class DatabaseRouterTests(SimpleTestCase):
    def setUp(self) -> None:
        self.router = DatabaseRouter()

    @parameterized.expand(
        [
            ("parcel", ParcelGeometry, DatabaseAlias.PARCELS),
            ("assessing", AssessingParcel, DatabaseAlias.PARCELS),
            ("address_point", AddressPoint, DatabaseAlias.PARCELS),
            ("config_version", ConfigVersion, DatabaseAlias.CONFIG_STORE),
            ("django_user", User, None),
        ]
    )
    def test_reads_and_writes_go_to_the_app_database(self, _name, model, alias) -> None:
        self.assertEqual(self.router.db_for_read(model), alias)
        # Parcel writes go to the read-only alias on purpose, so they fail loudly (ADR 0007).
        self.assertEqual(self.router.db_for_write(model), alias)

    @parameterized.expand(
        [
            ("parcels_not_in_default", "parcels", DatabaseAlias.DEFAULT, False),
            ("parcels_not_in_parcels_db", "parcels", DatabaseAlias.PARCELS, False),
            ("config_not_in_config_store", "county_config", DatabaseAlias.CONFIG_STORE, False),
            ("auth_in_default", "auth", DatabaseAlias.DEFAULT, True),
            ("auth_not_in_parcels_db", "auth", DatabaseAlias.PARCELS, False),
            ("auth_not_in_config_store", "auth", DatabaseAlias.CONFIG_STORE, False),
        ]
    )
    def test_only_django_tables_are_migrated_and_only_in_default(
        self, _name, app_label, db, allowed
    ) -> None:
        self.assertEqual(self.router.allow_migrate(db, app_label), allowed)


class DatabaseSettingsTests(SimpleTestCase):
    def _options(self, alias: str) -> str:
        return str(settings.DATABASES[alias]["OPTIONS"]["options"])

    def test_the_parcels_session_is_read_only_and_the_others_are_not(self) -> None:
        self.assertIn("default_transaction_read_only=on", self._options(DatabaseAlias.PARCELS))
        self.assertNotIn("read_only", self._options(DatabaseAlias.DEFAULT))
        self.assertNotIn("read_only", self._options(DatabaseAlias.CONFIG_STORE))

    def test_every_connection_is_pooled_capped_timed_out_and_named(self) -> None:
        for alias in DatabaseAlias:
            options = settings.DATABASES[alias]["OPTIONS"]
            with self.subTest(alias):
                self.assertEqual(options["pool"]["max_size"], 5)
                self.assertEqual(options["application_name"], "parcel-viewer-django")
                self.assertIn("statement_timeout=10000", options["options"])
