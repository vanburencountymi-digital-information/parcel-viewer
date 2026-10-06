from django.apps import apps
from django.test import SimpleTestCase

from parcels.models import AddressPoint

SCHEMA_QUALIFIED = r'^"(geo|assessing)"\."[a-z_]+"$'


class ParcelModelTests(SimpleTestCase):
    def test_every_parcel_model_is_unmanaged_and_schema_qualified(self) -> None:
        for model in apps.get_app_config("parcels").get_models():
            with self.subTest(model.__name__):
                self.assertFalse(model._meta.managed)
                self.assertRegex(model._meta.db_table, SCHEMA_QUALIFIED)

    def test_address_points_read_the_renamed_full_address_column(self) -> None:
        # The table was reloaded and full_address became fulladdr (DIC-2152).
        columns = [field.column for field in AddressPoint._meta.concrete_fields]

        self.assertIn("fulladdr", columns)
