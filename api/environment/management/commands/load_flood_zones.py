"""manage.py load_flood_zones: load a county's FEMA flood zones into our database (DIC-2412).

    python manage.py load_flood_zones --dfirm 26159C          # from FEMA's NFHL service
    python manage.py load_flood_zones --file zones.geojson \\
        --dfirm 26159C --effective 2026-06-10                 # from a saved download

The load replaces the stored zones in one transaction and records where the data came from
and its effective date (the newest FIRM panel). Run it after a FEMA map revision; checking
monthly is enough. Van Buren County's FIRM is 26159C.
"""

import json
import urllib.parse
import urllib.request
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from environment.flood import NFHL_LAYER, NFHL_PANELS, FloodDataError, load_features

FIELDS = "FLD_AR_ID,FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DEPTH,V_DATUM,DFIRM_ID,SOURCE_CIT"
PAGE = 1000  # FEMA's layer allows 2000 records a request
TIMEOUT_S = 180


def _get_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=TIMEOUT_S) as r:  # noqa: S310 — fixed FEMA host
        return json.loads(r.read().decode())


def fetch_zones(dfirm: str) -> tuple[list[dict[str, Any]], str]:
    """Takes a DFIRM id. Returns its flood zones as GeoJSON features, and the query URL."""
    where = urllib.parse.quote(f"DFIRM_ID='{dfirm}'")
    base = (
        f"{NFHL_LAYER}/query?where={where}&outFields={FIELDS}&outSR=4326"
        f"&returnGeometry=true&orderByFields=OBJECTID&f=geojson"
    )
    features: list[dict[str, Any]] = []
    while True:
        page = _get_json(f"{base}&resultOffset={len(features)}&resultRecordCount={PAGE}")
        batch = page.get("features") or []
        features.extend(batch)
        more = page.get("exceededTransferLimit") or (page.get("properties") or {}).get(
            "exceededTransferLimit"
        )
        if not batch or not more:
            return features, base


def fetch_effective_date(dfirm: str) -> date | None:
    """Takes a DFIRM id. Returns its newest FIRM panel's effective date, if FEMA lists one."""
    where = urllib.parse.quote(f"DFIRM_ID='{dfirm}'")
    data = _get_json(
        f"{NFHL_PANELS}/query?where={where}&outFields=EFF_DATE&returnGeometry=false"
        f"&returnDistinctValues=true&f=json"
    )
    stamps = [f["attributes"]["EFF_DATE"] for f in data.get("features") or []]
    stamps = [s for s in stamps if s]
    return datetime.fromtimestamp(max(stamps) / 1000, UTC).date() if stamps else None


class Command(BaseCommand):
    help = "Load a county's FEMA flood zones (NFHL) into the environment tables."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--dfirm", required=True, help="FEMA DFIRM id, e.g. 26159C")
        parser.add_argument("--file", help="a saved GeoJSON download instead of fetching")
        parser.add_argument("--effective", help="effective date (YYYY-MM-DD) for --file loads")

    def handle(self, *args: Any, **opts: Any) -> None:
        dfirm = opts["dfirm"].strip().upper()
        if opts["file"]:
            data = json.loads(Path(opts["file"]).read_text(encoding="utf-8"))
            features = data.get("features") or []
            source_url = f"{NFHL_LAYER} (file {Path(opts['file']).name})"
            effective = date.fromisoformat(opts["effective"]) if opts["effective"] else None
        else:
            self.stdout.write(f"Fetching FEMA flood zones for {dfirm}…")
            features, source_url = fetch_zones(dfirm)
            effective = fetch_effective_date(dfirm)
        features = [f for f in features if (f.get("properties") or {}).get("DFIRM_ID") == dfirm]
        try:
            load = load_features(
                features, source_url=source_url, source_id=dfirm, effective_date=effective
            )
        except FloodDataError as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(
            self.style.SUCCESS(
                f"Loaded {load.feature_count} flood zones for {dfirm} "
                f"(effective {load.effective_date or 'unknown'})."
            )
        )
