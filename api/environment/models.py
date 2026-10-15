"""Federal environmental layers, loaded into the API's own database (DIC-2412).

The viewer used to ask FEMA, USFWS and USDA live on every click and tile; their servers are
slow and often down. These tables hold a county copy instead, refreshed by the load
commands (environment/management/commands), and every load is recorded so a lookup can say
which data it answered from.
"""

from django.contrib.gis.db import models

WGS84 = 4326


class DatasetLoad(models.Model):
    """One load of a dataset: where it came from, how current it is, and how much arrived."""

    FLOOD = "fema_nfhl_flood"
    DATASETS = [(FLOOD, "FEMA National Flood Hazard Layer")]

    dataset = models.CharField(max_length=40, choices=DATASETS)
    source_url = models.URLField(max_length=500)
    # The publisher's id for what was loaded, e.g. FEMA's DFIRM id "26159C".
    source_id = models.CharField(max_length=40, blank=True)
    # The newest effective date in the source (FEMA: the latest FIRM panel).
    effective_date = models.DateField(null=True, blank=True)
    feature_count = models.PositiveIntegerField()
    loaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-loaded_at"]
        indexes = [models.Index(fields=["dataset", "-loaded_at"])]

    def __str__(self) -> str:
        return f"{self.get_dataset_display()} {self.source_id} ({self.loaded_at:%Y-%m-%d})"


class FloodZone(models.Model):
    """
    A FEMA flood hazard area (NFHL S_FLD_HAZ_AR). Field meanings follow FEMA's: `zone` is
    FLD_ZONE (A, AE, VE, X…), `sfha` is SFHA_TF (inside the 1% annual chance floodplain),
    `static_bfe` is the base flood elevation in feet where FEMA set one.
    """

    load = models.ForeignKey(DatasetLoad, on_delete=models.CASCADE, related_name="flood_zones")
    fld_ar_id = models.CharField(max_length=32, blank=True)
    zone = models.CharField(max_length=17)
    subtype = models.CharField(max_length=80, blank=True)
    sfha = models.BooleanField(null=True)
    static_bfe = models.FloatField(null=True, blank=True)
    depth = models.FloatField(null=True, blank=True)
    vertical_datum = models.CharField(max_length=17, blank=True)
    dfirm_id = models.CharField(max_length=6)
    source_citation = models.CharField(max_length=21, blank=True)
    geom = models.MultiPolygonField(srid=WGS84)

    def __str__(self) -> str:
        return f"Zone {self.zone} ({self.fld_ar_id})"
