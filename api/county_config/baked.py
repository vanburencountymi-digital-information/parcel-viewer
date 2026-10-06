"""The baked county manifests: the offline fallback when the config store is unset or down.

The JSON files in baked/ are copied byte for byte from backend/parcel_viewer/county_configs
until cutover (DIC-2149); a CI step fails if the two copies differ.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

BAKED_DIR = Path(__file__).resolve().parent / "baked"


def safe_county_key(key: str | None) -> str:
    """Takes a county key from a request. Returns it lowercased with only letters, digits, - and _."""
    return "".join(c for c in (key or "") if c.isalnum() or c in "-_").lower()


@lru_cache(maxsize=16)
def load_baked(key: str) -> dict[str, Any] | None:
    """Takes a county key. Returns its baked manifest, or None if unknown. No path traversal."""
    safe = safe_county_key(key)
    if not safe:
        return None
    path = BAKED_DIR / f"{safe}.json"
    if not path.is_file():
        return None
    manifest: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return manifest
