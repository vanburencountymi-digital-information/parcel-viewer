"""Parcel Viewer backend — read-only FastAPI app."""

import json
import os
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from parcel_viewer import config_store
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


# ── Writable config store (DIC-464 / DIC-466) ─────────────────────────────────
# Optional: active only when PV_WRITER_DATABASE_URL is set. The public read path
# always falls back to the baked manifest, so the viewer never hard-depends on it.
_ADMIN_TOKEN = os.getenv("PV_ADMIN_TOKEN", "")
_store_singleton = None


def _get_store():
    """Lazily build the store (and ensure its table), or None if not configured."""
    global _store_singleton
    if _store_singleton is None and config_store.is_configured():
        s = config_store.ConfigStore()
        s.init_schema()
        _store_singleton = s
    return _store_singleton


def _published_config(county: str) -> dict | None:
    """The manifest the viewer should serve: the store's published version when
    available, else the baked file. Any store error degrades to the baked file."""
    baked = _load_county_config(county)
    if config_store.is_configured():
        try:
            store = _get_store()
            data = store.get_published(county) if store else None
            if data is not None:
                return data
        except Exception:  # noqa: BLE001 — never let the store break the read path
            pass
    return baked


def _require_writer(x_admin_token: str | None = Header(default=None)):
    """Guard for write endpoints. Disabled (503) until a writer DSN is set; gated
    by an interim shared token until real auth lands (DIC-463)."""
    store = None
    if config_store.is_configured():
        try:
            store = _get_store()
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=503, detail=f"Config store error: {e}")
    if store is None:
        raise HTTPException(status_code=503, detail="Config store not configured (set PV_WRITER_DATABASE_URL).")
    if not _ADMIN_TOKEN or x_admin_token != _ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Admin auth required (interim PV_ADMIN_TOKEN; real auth is DIC-463).")
    return store


class DraftBody(BaseModel):
    payload: dict
    author: str | None = None


class PublishBody(BaseModel):
    author: str | None = None
    note: str | None = None


class RollbackBody(BaseModel):
    version: int
    author: str | None = None

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
    """The published per-county manifest as JSON (admin console + programmatic)."""
    data = _published_config(county)
    if data is None:
        return JSONResponse({"error": f"Unknown county: {county}"}, status_code=404)
    return data


@app.get("/config.js")
async def config_js(county: str = DEFAULT_COUNTY):
    """The published manifest as a script that sets `window.COUNTY`. The viewer
    loads this after the baked county-config.js, so it overrides at runtime when
    reachable and the baked copy stands as the offline fallback if it isn't."""
    data = _published_config(county)
    if data is None:
        return Response(
            f"/* Parcel Viewer: unknown county {county!r} */",
            media_type="application/javascript", status_code=404,
        )
    body = "window.COUNTY = " + json.dumps(data, ensure_ascii=False) + ";"
    return Response(body, media_type="application/javascript",
                    headers={"Cache-Control": "no-cache"})


# ── Config editing (writer-only; DIC-464 / DIC-466) ───────────────────────────
@app.get("/config/{county}/draft")
async def get_config_draft(county: str, store=Depends(_require_writer)):
    """The working draft (or the latest published / baked manifest if none yet)."""
    return store.get_draft(county) or _load_county_config(county) or {}


@app.put("/config/{county}/draft")
async def put_config_draft(county: str, body: DraftBody, store=Depends(_require_writer)):
    baked = _load_county_config(county)
    if baked:
        store.seed_if_empty(county, baked)   # establish v1 from baked before edits
    store.save_draft(county, body.payload, body.author)
    return {"ok": True}


@app.post("/config/{county}/publish")
async def publish_config(county: str, body: PublishBody, store=Depends(_require_writer)):
    baked = _load_county_config(county)
    if baked:
        store.seed_if_empty(county, baked)
    try:
        version = store.publish(county, body.author, body.note)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "version": version}


@app.get("/config/{county}/versions")
async def config_versions(county: str, store=Depends(_require_writer)):
    return {"versions": store.list_versions(county)}


@app.post("/config/{county}/rollback")
async def rollback_config(county: str, body: RollbackBody, store=Depends(_require_writer)):
    try:
        version = store.rollback(county, body.version, body.author)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True, "version": version}


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
