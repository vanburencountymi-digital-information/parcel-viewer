"""Parcel Viewer backend — read-only FastAPI app."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from parcel_viewer.db import close_pool, health_check, open_pool
from parcel_viewer.routers import feedback, parcels

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
