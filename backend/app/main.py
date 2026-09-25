"""Parcel Viewer backend — read-only FastAPI app."""

import hmac
import urllib.error
import urllib.request
import json
import logging
import os
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from psycopg.errors import QueryCanceled
from psycopg_pool import PoolTimeout
from pydantic import BaseModel
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from parcel_viewer import config_store
from parcel_viewer.common.error_logging_client import (
    ErrorLoggingClient,
    get_error_logging_client,
    init_error_monitoring,
)
from parcel_viewer.common.logging_setup import configure_logging, safe_for_log
from parcel_viewer.common.request_context import RequestContextMiddleware
from parcel_viewer.db import close_pool, health_check, open_pool, pool
from parcel_viewer.ratelimit import limiter
from parcel_viewer.routers import client_errors, feedback, parcels

# Unexpected errors are logged here in full; clients get a generic message, never the
# raw exception (DB driver messages carry hostnames and role names) (DIC-1855).
log = logging.getLogger("parcel_viewer.api")

# Observability (DIC-1879, ADR 0001): stdout logs with request ids, and Sentry when
# SENTRY_DSN is set (staging/production only).
APP_VERSION = os.getenv("APP_VERSION", "0.1.0")
configure_logging("parcel-api")
init_error_monitoring("parcel-api", APP_VERSION)

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


def _require_writer(
    x_admin_token: str | None = Header(default=None),
    errors: ErrorLoggingClient = Depends(get_error_logging_client),
):
    """Guard for write endpoints. Disabled (503) until a writer DSN is set; gated
    by an interim shared token until real auth lands (DIC-463)."""
    store = None
    if config_store.is_configured():
        try:
            store = _get_store()
        except Exception as exc:  # noqa: BLE001
            log.exception("config store unavailable")
            errors.report_exception(exc, tags={"operation": "config_store"})
            raise HTTPException(status_code=503, detail="Config store unavailable.")
    if store is None:
        raise HTTPException(status_code=503, detail="Config store not configured (set PV_WRITER_DATABASE_URL).")
    # Constant-time compare so response timing can't leak the token (DIC-1853).
    if not _ADMIN_TOKEN or not hmac.compare_digest(
        (x_admin_token or "").encode(), _ADMIN_TOKEN.encode()
    ):
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

# /wms-proxy hardening (DIC-1880 CodeQL py/full-ssrf; DIC-1872). The proxy fetches a
# caller-supplied URL, so beyond the host allowlist it must not follow redirects (a
# 30x to any host would bypass the allowlist), must not pass through content a browser
# would render as a page on our origin, and must bound what it reads.
_WMS_ALLOWED_TYPES = (
    "application/json", "application/geo+json", "application/xml", "text/xml",
    "application/vnd.ogc.", "text/plain", "image/png", "image/jpeg", "image/gif",
)
_WMS_MAX_BYTES = int(os.getenv("WMS_PROXY_MAX_BYTES", str(5 * 1024 * 1024)))


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect: urllib then raises HTTPError with the 30x status."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_wms_opener = urllib.request.build_opener(_NoRedirects)


def _wms_target(url: str) -> str | None:
    """Takes the caller's URL; returns a rebuilt https URL on an allowed host, or None."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return None
    if parsed.port not in (None, 443):
        return None
    if not any(host == h or host.endswith("." + h) for h in ALLOWED_WMS_HOSTS):
        return None
    return urlunparse(("https", host, parsed.path or "/", "", parsed.query, ""))


@asynccontextmanager
async def lifespan(app: FastAPI):
    open_pool()
    yield
    close_pool()
    if _store_singleton is not None:
        _store_singleton.close()


# Interactive API docs are off unless PV_API_DOCS=1 (DIC-1855): /docs and /openapi.json
# publish every route, including the admin/config ones, to anyone. The dev compose
# turns them on.
_DOCS = os.getenv("PV_API_DOCS", "") == "1"
app = FastAPI(
    title="Parcel Viewer API", version=APP_VERSION, lifespan=lifespan,
    docs_url="/docs" if _DOCS else None,
    redoc_url="/redoc" if _DOCS else None,
    openapi_url="/openapi.json" if _DOCS else None,
)

# CORS (DIC-1852). The viewer and admin console call the API same-origin through
# nginx (/api/), so CORS only governs third-party browser callers. Allow just the
# prod viewer origins by default; override with a comma-separated PV_CORS_ORIGINS.
# No credentials: the API uses no cookies (admin writes send X-Admin-Token).
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "PV_CORS_ORIGINS", "https://parcels.dicemi.org,https://map.dicemi.org"
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Content-Type", "X-Admin-Token"],
    expose_headers=["X-Request-ID"],
)

# Rate limiting (DIC-496). Applied per-endpoint via @limiter.limit on the public
# unauthenticated abuse surfaces: /wms-proxy and /report-error (DIC-1852).
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Every route is a plain `def` (DIC-1853): the psycopg pool, config store and urllib
# calls all block, so FastAPI must run them in its threadpool — an `async def` doing
# blocking I/O stalls the event loop and every other request with it.
#
# A statement past PV_STATEMENT_TIMEOUT_MS, or no free pool connection within
# PV_POOL_TIMEOUT_S, is load — answer 503 rather than an opaque 500.
@app.exception_handler(QueryCanceled)
@app.exception_handler(PoolTimeout)
async def _db_overloaded(request: Request, exc: Exception):
    # Load, not a bug: a warning (with the request id) rather than a Sentry report.
    log.warning("database busy: %s on %s", type(exc).__name__, request.url.path)
    return JSONResponse({"error": "database busy, try again"}, status_code=503)


app.include_router(parcels.router, tags=["parcels"])
app.include_router(feedback.router, tags=["feedback"])
app.include_router(client_errors.router, tags=["client-errors"])

# Added last so it wraps everything else: every response, including CORS and
# rate-limit rejections, gets a request id and an access-log line.
app.add_middleware(RequestContextMiddleware)


@app.get("/health")
def health():
    """Liveness + readiness: 200 when the database answers, 503 when it doesn't, so
    uptime checks and the container health check see a real outage."""
    db_ok = health_check()
    if not db_ok:
        log.warning("health check: database unreachable")
        return JSONResponse({"status": "degraded", "db": False}, status_code=503)
    return {"status": "ok", "db": True}


@app.get("/config")
def config(county: str = DEFAULT_COUNTY):
    """The published per-county manifest as JSON (admin console + programmatic)."""
    data = _published_config(county)
    if data is None:
        return JSONResponse({"error": f"Unknown county: {county}"}, status_code=404)
    return data


@app.get("/config.js")
def config_js(county: str = DEFAULT_COUNTY):
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

import re as _re


def _tile_fields(src: str) -> list[str]:
    """The non-geometry MVT properties a tile function exposes, parsed from its
    SELECT list (the columns feeding ST_AsMVT, before ST_AsMVTGeom). Drives the
    label / attribute pickers in the console with the layer's REAL attributes."""
    if not src:
        return []
    i = src.find("ST_AsMVTGeom")
    if i < 0:
        return []
    head = src[:i]
    j = head.rfind("SELECT")
    if j < 0:
        return []
    out: list[str] = []
    for part in head[j + 6:].split(","):
        m = _re.match(r"\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*$", part)
        if m:
            name = m.group(1).lower()
            if name not in ("geom", "id"):
                out.append(name)
    return out


def _discover_layers(county: str) -> list[dict]:
    cfg = _published_config(county) or {}
    overlays = (cfg.get("layers") or {}).get("overlays") or []
    registered = {o.get("source") for o in overlays if str(o.get("type", "")).lower() == "vector"}

    rows: list[dict] = []
    with pool.connection() as conn:
        funcs = conn.execute(
            "SELECT proname, pg_get_functiondef(p.oid) AS def "
            "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
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
                "fields": _tile_fields(f["def"]),
            })
    return rows


@app.get("/admin/discover/layers")
def discover_layers(
    county: str = DEFAULT_COUNTY,
    errors: ErrorLoggingClient = Depends(get_error_logging_client),
):
    """Spatial layers Martin can serve, for Admin-Console registration (DIC-502)."""
    try:
        return {"layers": _discover_layers(county)}
    except Exception as exc:  # noqa: BLE001
        log.exception("layer discovery failed")
        errors.report_exception(exc, tags={"operation": "discover_layers"})
        return JSONResponse({"error": "layer discovery failed", "layers": []}, status_code=500)


# ── Config editing (writer-only; DIC-464 / DIC-466) ───────────────────────────
@app.get("/config/{county}/draft")
def get_config_draft(county: str, store=Depends(_require_writer)):
    """The working draft (or the latest published / baked manifest if none yet)."""
    return store.get_draft(county) or _load_county_config(county) or {}


@app.put("/config/{county}/draft")
def put_config_draft(county: str, body: DraftBody, store=Depends(_require_writer)):
    baked = _load_county_config(county)
    if baked:
        store.seed_if_empty(county, baked)   # establish v1 from baked before edits
    store.save_draft(county, body.payload, body.author)
    return {"ok": True}


@app.post("/config/{county}/publish")
def publish_config(county: str, body: PublishBody, store=Depends(_require_writer)):
    baked = _load_county_config(county)
    if baked:
        store.seed_if_empty(county, baked)
    try:
        version = store.publish(county, body.author, body.note)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "version": version}


@app.get("/config/{county}/versions")
def config_versions(county: str, store=Depends(_require_writer)):
    return {"versions": store.list_versions(county)}


@app.post("/config/{county}/rollback")
def rollback_config(county: str, body: RollbackBody, store=Depends(_require_writer)):
    try:
        version = store.rollback(county, body.version, body.author)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True, "version": version}


@app.get("/wms-proxy")
@limiter.limit(os.getenv("WMS_PROXY_RATE_LIMIT", "45/minute"))
def wms_proxy(request: Request, url: str):
    """Proxy WMS GetFeatureInfo / GetLegendGraphic requests server-side.

    Per-IP rate limited (DIC-496) — the only unauthenticated abuse surface here.
    Baseline is ~30–60 req/min per active user (up to 3 parallel overlay calls
    per map click), so the default 45/minute is tunable via WMS_PROXY_RATE_LIMIT.
    """
    target = _wms_target(url)
    if target is None:
        return JSONResponse({"error": "URL not allowed"}, status_code=403)
    host = safe_for_log(urlparse(target).hostname or "", 100)   # for log lines only

    try:
        req = urllib.request.Request(target, headers={"User-Agent": "ParcelViewer/1.0"})
        with _wms_opener.open(req, timeout=10) as resp:
            content = resp.read(_WMS_MAX_BYTES + 1)
            content_type = resp.headers.get("Content-Type", "text/xml")
    except urllib.error.HTTPError as e:
        # Third-party outages (FEMA, USFWS, NRCS) aren't our bugs: logged as warnings,
        # not sent to Sentry, so they can't bury real errors (ADR 0001). Redirects land
        # here too (refused). The upstream body is never passed back.
        log.warning("wms-proxy upstream %s returned %s", host, e.code)
        return JSONResponse({"error": f"upstream map service returned {e.code}"}, status_code=502)
    except Exception:
        log.warning("wms-proxy upstream request failed: %s", host, exc_info=True)
        return JSONResponse({"error": "upstream map service unavailable"}, status_code=502)

    if len(content) > _WMS_MAX_BYTES:
        log.warning("wms-proxy upstream %s response over %s bytes", host, _WMS_MAX_BYTES)
        return JSONResponse({"error": "upstream response too large"}, status_code=502)
    base_type = content_type.split(";", 1)[0].strip().lower()
    if not base_type.startswith(_WMS_ALLOWED_TYPES):
        log.warning("wms-proxy upstream %s sent unexpected type %s", host, safe_for_log(base_type, 100))
        return JSONResponse({"error": "unexpected upstream content"}, status_code=502)
    return Response(content=content, media_type=content_type,
                    headers={"X-Content-Type-Options": "nosniff"})
