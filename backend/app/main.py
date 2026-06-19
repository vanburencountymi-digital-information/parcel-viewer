"""Parcel Viewer backend — read-only FastAPI app."""

import json
import os
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from parcel_viewer import config_store
from parcel_viewer.db import close_pool, health_check, open_pool, pool
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

# Rate limiting (DIC-496). Applied per-endpoint via @limiter.limit — today only
# /wms-proxy, the public unauthenticated abuse surface. Behind nginx the real
# client IP arrives as X-Real-IP (proxy_set_header is set on /api/); fall back to
# the socket peer for direct/local requests.
def _client_ip(request: Request) -> str:
    return request.headers.get("X-Real-IP") or get_remote_address(request)


limiter = Limiter(key_func=_client_ip)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

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


# ── PostGIS layer discovery (DIC-502) ─────────────────────────────────────────
# Introspect the spatial layers that Martin can serve (geo.<name>_tiles function
# sources) so the Admin Console can discover and register them as viewer overlays
# without a developer. Read-only; the data is public assessment-adjacent GIS.
# TODO(DIC-463): gate behind admin auth once real auth lands.
_GEOM_KIND = {  # PostGIS GeometryType() → viewer geomType
    "POINT": "point", "MULTIPOINT": "point",
    "LINESTRING": "line", "MULTILINESTRING": "line",
    "POLYGON": "polygon", "MULTIPOLYGON": "polygon",
}
# reference_layers is one table split into several tile functions by feature_type.
_REFERENCE_FEATURE = {"roads": "road", "drains": "drain", "section_lines": "section_line"}


def _discover_layers(county: str) -> list[dict]:
    cfg = _published_config(county) or {}
    overlays = (cfg.get("layers") or {}).get("overlays") or []
    registered = {o.get("source") for o in overlays if str(o.get("type", "")).lower() == "vector"}

    rows: list[dict] = []
    with pool.connection() as conn:
        funcs = conn.execute(
            "SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = 'geo' AND proname LIKE %s ORDER BY proname",
            ("%\\_tiles",),
        ).fetchall()
        tables = {
            r["relname"]
            for r in conn.execute(
                "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = 'geo' AND c.relkind IN ('r', 'v', 'm', 'p')"
            ).fetchall()
        }

        def sample(table: str, where_ft: str | None):
            """Geometry kind + SRID + row count for a geo table (optionally filtered)."""
            ident = f'geo."{table}"'
            clause = " WHERE feature_type = %s" if where_ft else ""
            args = (where_ft,) if where_ft else ()
            geom_kind = srid = count = None
            try:
                g = conn.execute(
                    f"SELECT GeometryType(geom) AS gt, ST_SRID(geom) AS srid FROM {ident}"
                    + (clause or " WHERE geom IS NOT NULL") + " LIMIT 1",
                    args,
                ).fetchone()
                if g:
                    geom_kind = _GEOM_KIND.get((g["gt"] or "").upper())
                    srid = g["srid"]
                count = conn.execute(f"SELECT count(*) AS n FROM {ident}{clause}", args).fetchone()["n"]
            except Exception:  # noqa: BLE001 — discovery never fails the request
                conn.rollback()
            return geom_kind, srid, count

        for f in funcs:
            src = f["proname"]                          # e.g. "subdivisions_tiles"
            base = src[:-6] if src.endswith("_tiles") else src
            if base == "parcel":                        # parcels is the base layer, not an overlay
                continue
            if base in tables:
                geom_kind, srid, count = sample(base, None)
                db_table = f"geo.{base}"
            elif base.startswith("reference_"):
                ft = _REFERENCE_FEATURE.get(base[len("reference_"):])
                geom_kind, srid, count = sample("reference_layers", ft) if ft else (None, None, None)
                db_table = "geo.reference_layers" + (f" (feature_type={ft})" if ft else "")
            else:
                geom_kind, srid, count, db_table = None, None, None, None
            rows.append({
                "id": base, "source": src, "sourceLayer": base,
                "geomType": geom_kind, "srid": srid, "rowCount": count,
                "dbSource": db_table, "registered": src in registered,
            })
    return rows


@app.get("/admin/discover/layers")
async def discover_layers(county: str = DEFAULT_COUNTY):
    """Spatial layers Martin can serve, for Admin-Console registration (DIC-502)."""
    try:
        return {"layers": _discover_layers(county)}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e), "layers": []}, status_code=500)


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
@limiter.limit(os.getenv("WMS_PROXY_RATE_LIMIT", "45/minute"))
async def wms_proxy(request: Request, url: str):
    """Proxy WMS GetFeatureInfo / GetLegendGraphic requests server-side.

    Per-IP rate limited (DIC-496) — the only unauthenticated abuse surface here.
    Baseline is ~30–60 req/min per active user (up to 3 parallel overlay calls
    per map click), so the default 45/minute is tunable via WMS_PROXY_RATE_LIMIT.
    """
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
