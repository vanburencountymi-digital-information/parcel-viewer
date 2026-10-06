"""Read-only models over the parcel tables another pipeline owns (ADR 0006, ADR 0007).

Generated with `inspectdb` from the shared database on 2026-10-06 and tidied: singular
names, schema-qualified tables, explicit primary keys, and real types where inspectdb
guessed. Never migrated (`managed = False`); the parcels connection is read-only, so a save
fails at the database. Geometry is stored in Michigan State Plane South, feet (EPSG:2253).

Column names stay exactly as in the database. Phase 3 (DIC-2149) ports routes with their
existing SQL first; these models carry the ORM where it reads better.
"""

from django.contrib.gis.db import models
from django.contrib.postgres.fields import ArrayField

STATE_PLANE_SOUTH_FT = 2253


class ParcelGeometry(models.Model):
    """One parcel's boundary and identity. Superseded rows have archived_at set."""

    id = models.BigAutoField(primary_key=True)
    parcel_no = models.TextField()
    county = models.TextField()
    municipality = models.TextField()
    geom = models.MultiPolygonField(srid=STATE_PLANE_SOUTH_FT)
    acres = models.FloatField(blank=True, null=True)
    area = models.FloatField(blank=True, null=True)
    source_file = models.TextField(blank=True, null=True)
    loaded_at = models.DateTimeField(blank=True, null=True)
    legal_description = models.TextField(blank=True, null=True)
    tax_description = models.TextField(blank=True, null=True)
    cogo_legs = models.JSONField(blank=True, null=True)
    source = models.TextField()
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()
    archived_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = '"geo"."parcel_geometry"'


class ParcelLedgerEvent(models.Model):
    """A recorded change to a parcel's geometry (split, merge, COGO commit, ...)."""

    event_id = models.UUIDField(primary_key=True)
    parcel = models.ForeignKey(ParcelGeometry, models.DO_NOTHING, related_name="ledger_events")
    event_type = models.TextField()
    event_timestamp = models.DateTimeField()
    # Never served: the history route hides operator and notes (DIC-1872).
    operator_id = models.TextField()
    source_document = models.TextField(blank=True, null=True)
    closure_error = models.DecimalField(blank=True, null=True, max_digits=None, decimal_places=None)
    precision_ratio = models.TextField(blank=True, null=True)
    bowditch_applied = models.BooleanField(blank=True, null=True)
    cogo_legs = models.JSONField(blank=True, null=True)
    geometry_before = models.MultiPolygonField(srid=STATE_PLANE_SOUTH_FT, blank=True, null=True)
    geometry_after = models.MultiPolygonField(srid=STATE_PLANE_SOUTH_FT, blank=True, null=True)
    related_parcel_ids = ArrayField(models.IntegerField(), blank=True, null=True)
    notes = models.TextField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = '"geo"."parcel_ledger_events"'


class AssessingParcel(models.Model):
    """The assessor's record for a parcel (assessing.vbc_parcels), matched by parcel number."""

    id = models.BigAutoField(primary_key=True)
    pnum = models.TextField()
    mapnum = models.TextField(blank=True, null=True)
    school_dist = models.TextField(blank=True, null=True)
    prop_class = models.TextField(blank=True, null=True)
    homestead = models.DecimalField(blank=True, null=True, max_digits=None, decimal_places=None)
    qual_ag = models.TextField(blank=True, null=True)
    frontage = models.FloatField(blank=True, null=True)
    avg_depth = models.FloatField(blank=True, null=True)
    assessed_value = models.IntegerField(blank=True, null=True)
    taxable_value = models.IntegerField(blank=True, null=True)
    prev_assessed_value = models.IntegerField(blank=True, null=True)
    prev_taxable_value = models.IntegerField(blank=True, null=True)
    assessed_value_yr0 = models.IntegerField(blank=True, null=True)
    assessed_value_yr1 = models.IntegerField(blank=True, null=True)
    assessed_value_yr2 = models.IntegerField(blank=True, null=True)
    assessed_value_yr3 = models.IntegerField(blank=True, null=True)
    assessed_value_yr4 = models.IntegerField(blank=True, null=True)
    owner_name = models.TextField(blank=True, null=True)
    prop_street = models.TextField(blank=True, null=True)
    prop_city = models.TextField(blank=True, null=True)
    prop_state = models.TextField(blank=True, null=True)
    prop_zip = models.TextField(blank=True, null=True)
    owner_street = models.TextField(blank=True, null=True)
    owner_city = models.TextField(blank=True, null=True)
    owner_state = models.TextField(blank=True, null=True)
    owner_zip = models.TextField(blank=True, null=True)
    legal_description = models.TextField(blank=True, null=True)
    loaded_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = '"assessing"."vbc_parcels"'


class ReferenceLayer(models.Model):
    """Reference lines such as roads (feature_type = 'road'), used to snap Street View."""

    id = models.AutoField(primary_key=True)
    feature_type = models.TextField()
    name = models.TextField(blank=True, null=True)
    source = models.TextField(blank=True, null=True)
    source_id = models.TextField(blank=True, null=True)
    geom = models.MultiLineStringField(srid=STATE_PLANE_SOUTH_FT)
    loaded_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = '"geo"."reference_layers"'


class AddressPoint(models.Model):
    """
    The county's address points, loaded from its shapefile. Only the columns the API reads
    are declared; the table has about 60 (NG911 fields). Reloads can rename columns, as
    full_address → fulladdr did (DIC-2152).
    """

    id = models.AutoField(primary_key=True)
    fulladdr = models.TextField(blank=True, null=True)
    geom = models.PointField(srid=STATE_PLANE_SOUTH_FT)
    source_file = models.TextField(blank=True, null=True)
    loaded_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = '"geo"."address_points"'


class Subdivision(models.Model):
    """Recorded subdivisions, used as a cohort geography."""

    id = models.AutoField(primary_key=True)
    shapefile_id = models.BigIntegerField(blank=True, null=True)
    sub_name = models.TextField(blank=True, null=True)
    unit = models.TextField(blank=True, null=True)
    twp_range = models.TextField(blank=True, null=True)
    link = models.TextField(blank=True, null=True)
    geom = models.MultiPolygonField(srid=STATE_PLANE_SOUTH_FT)
    source_file = models.TextField(blank=True, null=True)
    loaded_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = '"geo"."subdivisions"'


class PlssSection(models.Model):
    """
    Public Land Survey sections, used as a cohort geography. Only the columns the API reads
    are declared.
    """

    id = models.AutoField(primary_key=True)
    twnrngsec = models.TextField(blank=True, null=True)
    muni = models.TextField(blank=True, null=True)
    sq_ft = models.FloatField(blank=True, null=True)
    geom = models.MultiPolygonField(srid=STATE_PLANE_SOUTH_FT)
    source_file = models.TextField(blank=True, null=True)
    loaded_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = '"geo"."plss_sections"'
