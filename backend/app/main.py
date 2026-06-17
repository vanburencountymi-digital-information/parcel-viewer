"""Parcel Viewer backend — read-only FastAPI app."""

import json
import os
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from parcel_viewer.db import close_pool, health_check, open_pool
from parcel_viewer.routers import feedback, parcels

# ── County config manifests (DIC-465) ────────────────────────────────────────
# Server-side source of truth for the per-county manifest the viewer & admin
# console boot from. Replaces the static county-config.js bake; that file remains
# only as an offline fallback. One JSON per county under county_configs/.
_COUNTY_CONFIG_DIR = Path(__file__).resolve().parents[1] / "parcel_viewer" / "county_configs"
DEFAULT_COUNTY = os.getenv("PV_DEFAULT_COUNTY", "vanburen")


@lru_cache(maxsize=16)
def _load_county_config(key: str) -> dict | None:
    """Load a county manifest by key, or None if unknown. Path-safe (no traversal)."""
    safe = "".join(c for c in (key or "") if c.isalnum() or c in "-_").lower()
    if not safe:
        return None
    path = _COUNTY_CONFIG_DIR / f"{safe}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))

ALLOWED_WMS_HOSTS = (
    "hazards.fema.gov",
    "fwspublicservices.wim.usgs.gov",
    "sdmdataaccess.nrcs.usda.gov",
    "elevation.nationalmap.gov",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    open_pool()
    yield
    close_pool()


app = FastAPI(title="Parcel Viewer API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(parcels.router, tags=["parcels"])
app.include_router(feedback.router, tags=["feedback"])


@app.get("/health")
async def health():
    return {"status": "ok", "db": health_check()}


@app.get("/config")
async def config(county: str = DEFAULT_COUNTY):
    """The per-county manifest as JSON (admin console + programmatic consumers)."""
    data = _load_county_config(county)
    if data is None:
        return JSONResponse({"error": f"Unknown county: {county}"}, status_code=404)
    return data


@app.get("/config.js")
async def config_js(county: str = DEFAULT_COUNTY):
    """The manifest as a script that sets `window.COUNTY`. The viewer loads this
    after the baked county-config.js, so it overrides at runtime when reachable
    and the baked copy stands as the offline fallback if it isn't."""
    data = _load_county_config(county)
    if data is None:
        return Response(
            f"/* Parcel Viewer: unknown county {county!r} */",
            media_type="application/javascript", status_code=404,
        )
    body = "window.COUNTY = " + json.dumps(data, ensure_ascii=False) + ";"
    return Response(body, media_type="application/javascript",
                    headers={"Cache-Control": "no-cache"})


@app.get("/wms-proxy")
async def wms_proxy(url: str):
    """Proxy WMS GetFeatureInfo / GetLegendGraphic requests server-side."""
    import urllib.error
    import urllib.request
    from urllib.parse import urlparse

    host = urlparse(url).hostname or ""
    if not any(host == h or host.endswith("." + h) for h in ALLOWED_WMS_HOSTS):
        return JSONResponse({"error": f"Host not allowed: {host}"}, status_code=403)

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ParcelViewer/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read()
            content_type = resp.headers.get("Content-Type", "text/xml")
        return Response(content=content, media_type=content_type)
    except urllib.error.HTTPError as e:
        return Response(
            content=e.read(),
            status_code=e.code,
            media_type=e.headers.get("Content-Type", "text/plain"),
        )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)
