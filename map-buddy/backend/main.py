"""Map Buddy microservice — standalone FastAPI backend for the Map Buddy AI assistant."""

import json
import logging
import os
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env", override=True)

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from agent import run_chat_stream, WORKFLOWS, _expand_workflow, run_explain, run_autoconfigure, run_grounding_judge, run_describe_cohort, explainer_profiles_public
import cache as result_cache
import usage as ai_usage
import kb_resolver

# KB-backed Citation Renderer resolver (DIC-522 / §6.4): reads through the A6 KnowledgeStore
# seam so the viewer's Sources panel can resolve a citation to full section text + a precise
# passage. Built lazily/fail-soft — citations are facts (not AI), so a KB outage must degrade
# (the viewer falls back to its curated-statute resolver), never 500. Default backend is a
# local JSON fixture (live-verifiable without db-dice/Drake; the dice live-smoke is gated).
try:
    _KB_STORE = kb_resolver.build_kb_store()
except Exception as _kb_err:  # noqa: BLE001 — never block boot on KB wiring
    _KB_STORE = None
    print(f"[kb] resolver disabled at boot: {_kb_err}")


# The tenant is fixed per deployment, never read from the request (DIC-1854): a
# client-supplied tenant let callers mint a fresh quota bucket (and a cache miss)
# per request. One Map Buddy deployment serves one county.
SERVER_TENANT = os.getenv("MAP_BUDDY_TENANT", "vanburen")

# Server-side request caps (DIC-1854). The browser trims history to 12 turns, but a
# direct caller could send hundreds of KB per request, and /chat runs up to
# MAP_BUDDY_MAX_ITERS model calls over it. Body size bounds every AI route at once.
MAX_BODY_BYTES = int(os.getenv("MAP_BUDDY_MAX_BODY_BYTES", str(64 * 1024)))
MAX_MESSAGE_CHARS = int(os.getenv("MAP_BUDDY_MAX_MESSAGE_CHARS", "2000"))
MAX_HISTORY_TURNS = int(os.getenv("MAP_BUDDY_MAX_HISTORY", "12"))
# Free-form payloads (facts/grounding) go straight into the prompt, so bound them well
# below the body cap: the frontend's real payloads are a few KB (DIC-1870).
MAX_FACTS_BYTES = int(os.getenv("MAP_BUDDY_MAX_FACTS_BYTES", str(24 * 1024)))


def _payload_too_large(obj):
    """An {ok:false} response if obj serializes (compactly) past MAX_FACTS_BYTES, else None."""
    if len(json.dumps(obj, separators=(",", ":"), default=str)) > MAX_FACTS_BYTES:
        return {"ok": False, "error": "request payload too large"}
    return None


# Unexpected errors are logged in full; callers get "<route> failed" without the raw
# exception text (SDK errors carry request ids, model names, key status) (DIC-1855).
log = logging.getLogger("map_buddy")


def _quota_block(tenant):
    """If the tenant is over its AI quota, return a degrade-to-AI-off response (C3 /
    DIC-584); the viewer falls back to facts (B4). Returns None when the call may proceed.
    Call AFTER the cache check (cache hits are free) and BEFORE the model call. It
    reserves (counts) the call atomically, so callers don't record() again."""
    allowed, remaining = ai_usage.reserve(tenant)   # counts the call if allowed
    if not allowed:
        return {"ok": False, "error": "AI quota exceeded for this tenant; using AI-off.",
                "degraded": True, "quota_remaining": 0}
    return None

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost,http://localhost:8080,http://localhost:5173",
    ).split(",")
    if o.strip()
]

limiter = Limiter(key_func=get_remote_address)
# Interactive API docs are off unless MAP_BUDDY_API_DOCS=1 (DIC-1855); the Cloud Run
# service is public, so /docs would advertise /judge, /autoconfigure etc. to anyone.
_DOCS = os.getenv("MAP_BUDDY_API_DOCS", "") == "1"
app = FastAPI(
    title="Map Buddy Service", version="0.1.0",
    docs_url="/docs" if _DOCS else None,
    redoc_url="/redoc" if _DOCS else None,
    openapi_url="/openapi.json" if _DOCS else None,
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

class _BodySizeLimit:
    """Reject request bodies over MAX_BODY_BYTES with 413 — checks Content-Length up front
    and counts streamed (chunked) bodies, so no route ever parses an oversized payload."""

    def __init__(self, app, max_bytes: int):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        for k, v in scope.get("headers") or []:
            if k == b"content-length" and v.isdigit() and int(v) > self.max_bytes:
                return await self._reject(send)
        seen, rejected = 0, False

        async def limited_receive():
            # Streamed body: once over the cap, answer 413 ourselves and tell the app
            # the client went away (raising here would be swallowed by body parsing).
            nonlocal seen, rejected
            if rejected:
                return {"type": "http.disconnect"}
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > self.max_bytes:
                    rejected = True
                    await self._reject(send)
                    return {"type": "http.disconnect"}
            return msg

        async def guarded_send(msg):
            if not rejected:
                await send(msg)

        await self.app(scope, limited_receive, guarded_send)

    async def _reject(self, send):
        body = json.dumps({"ok": False, "error": "request too large"}).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


app.add_middleware(_BodySizeLimit, max_bytes=MAX_BODY_BYTES)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class ParcelContext(BaseModel):
    pin: str | None = None
    acres: float | None = None
    owner_name: str | None = None
    site_address: str | None = None
    municipality: str | None = None
    centroid: list | None = None
    bbox: list | None = None


class ChatMessage(BaseModel):
    # Only real conversation roles: a free-form role let a client inject fake turns
    # (or trigger an API error with an invalid one).
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class MapState(BaseModel):
    center: list | None = None
    zoom: float | None = None
    bearing: float | None = None
    pitch: float | None = None
    visible_layers: list | None = None
    # Live layer registry (DIC-327): [{id, label, type, visible, fields}, ...].
    layers: list | None = None


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    # Hard ceiling on what's accepted; the route keeps only the last MAX_HISTORY_TURNS.
    conversation_history: list[ChatMessage] = Field(default=[], max_length=50)
    parcel_context: ParcelContext | None = None
    map_state: MapState | None = None


class WorkflowRequest(BaseModel):
    workflow: str
    pin: str | None = None
    params: dict = {}
    parcel_context: ParcelContext | None = None


class ExplainRequest(BaseModel):
    # Topic selects the explainer (currently "assessment", DIC-370). `facts` is the
    # deterministic, pre-verified figures the caller assembled — the model only
    # narrates them, so the frontend (not the model) owns the authoritative numbers.
    topic: str = "assessment"
    facts: dict = {}


class AutoconfigureRequest(BaseModel):
    # B3 (DIC-579): the theme-composer's AI refinement. `draft` is the DETERMINISTIC
    # manifest the engine core already assembled; the model only narrates over it
    # (rationale + suggestions), never originates it — so the frontend owns the manifest.
    brief: dict = {}
    draft: dict = {}
    rationale: str = ""


class JudgeRequest(BaseModel):
    # C5 (DIC-586): LLM-judge grounding gate. `output` is the AI text to audit; `grounding`
    # is the deterministic truth it should rely on. A gate run before prompt/model changes
    # ship — not a per-request hot path.
    output: str = ""
    grounding: dict = {}


class DescribeCohortRequest(BaseModel):
    # DIC-588: the cohort-analyze narrate seam. `facts` is the DETERMINISTIC profile the
    # engine core (ISV_COHORT_ANALYZE_CORE) already computed for an area; the model only
    # characterizes them in plain language, never originating a number (facts-parity §4.6).
    facts: dict = {}


class KbResolveRequest(BaseModel):
    # DIC-522 / §6.4: a citation envelope to resolve against the County Knowledge Base.
    # `envelope` = { source_id, anchor, span, highlight_text? }. `jurisdiction` overrides the
    # store's default tenant (fail-closed); `domain` narrows the KB ('assessing'/'zoning').
    envelope: dict = {}
    jurisdiction: str | None = None
    domain: str | None = None


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/status")
async def status():
    """Operational health for monitoring (C4 / DIC-585): AI availability, result-cache
    stats, and per-tenant quota usage. No secrets — counts + config only, safe to scrape."""
    return {
        "status": "ok",
        "version": "0.1.0",
        "ai_available": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "cache": result_cache.stats(),
        "quota": ai_usage.snapshot(),
    }


@app.get("/config")
async def config():
    return {"version": "0.1.0", "capabilities": ["chat", "map_commands"]}


@app.post("/chat")
@limiter.limit(os.getenv("MAP_BUDDY_RATE_LIMIT", "120/minute"))
async def chat(request: Request, body: ChatRequest):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return StreamingResponse(
            iter([f'data: {json.dumps({"type": "error", "message": "ANTHROPIC_API_KEY not configured."})}\n\n']),
            media_type="text/event-stream",
        )

    # /chat had no quota at all (DIC-1854). One chat request counts as one AI call.
    blocked = _quota_block(SERVER_TENANT)
    if blocked:
        return StreamingResponse(
            iter([f'data: {json.dumps({"type": "error", "message": blocked["error"], "degraded": True})}\n\n']),
            media_type="text/event-stream",
        )
    history = body.conversation_history[-MAX_HISTORY_TURNS:] if MAX_HISTORY_TURNS > 0 else []

    def stream():
        ms = body.map_state.model_dump() if body.map_state else None
        for event in run_chat_stream(body.message, history, body.parcel_context, ms):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/explain")
@limiter.limit(os.getenv("EXPLAIN_RATE_LIMIT", os.getenv("MAP_BUDDY_RATE_LIMIT", "60/minute")))
def explain(request: Request, body: ExplainRequest):
    """Generate a grounded, structured explanation for a parcel (DIC-370). The
    caller passes pre-verified figures; the model only narrates them. Returns
    {ok, explanation} or {ok: false, error} so the frontend can fall back to the
    static educational stub when the key/service is unavailable."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"ok": False, "error": "ANTHROPIC_API_KEY not configured."}
    facts = body.facts or {}
    too_big = _payload_too_large(facts)
    if too_big:
        return too_big
    # C3 result cache: the same parcel explained twice shouldn't pay twice. Tenant-scoped.
    tenant = SERVER_TENANT
    ck = result_cache.cache_key("explain:" + body.topic, tenant, facts)
    if result_cache.enabled():
        hit = result_cache.get_cache().get(ck)
        if hit is not None:
            return {"ok": True, "explanation": hit, "cached": True}
    blocked = _quota_block(tenant)
    if blocked:
        return blocked
    try:
        explanation = run_explain(body.topic, facts)
        if result_cache.enabled():
            result_cache.get_cache().set(ck, explanation)
        return {"ok": True, "explanation": explanation, "cached": False}
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    except Exception:  # noqa: BLE001 — surface a clean message; frontend degrades
        log.exception("explainer failed")
        return {"ok": False, "error": "explainer failed"}


@app.post("/autoconfigure")
@limiter.limit(os.getenv("AUTOCONFIGURE_RATE_LIMIT", os.getenv("MAP_BUDDY_RATE_LIMIT", "60/minute")))
def autoconfigure(request: Request, body: AutoconfigureRequest):
    """AI refinement for the Theme Composer (B3 / DIC-579). The engine assembled a
    deterministic draft; the model adds a plain-language rationale + optional suggested
    tweaks over it, never changing the manifest. Returns {ok, refinement:{rationale,
    suggestions}} or {ok:false, error} so the console degrades to the baseline draft."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"ok": False, "error": "ANTHROPIC_API_KEY not configured."}
    if not body.draft:
        return {"ok": False, "error": "no draft manifest to refine."}
    tenant = SERVER_TENANT
    ck = result_cache.cache_key("autoconfigure", tenant, {"brief": body.brief, "draft": body.draft})
    if result_cache.enabled():
        hit = result_cache.get_cache().get(ck)
        if hit is not None:
            return {"ok": True, "refinement": hit, "cached": True}
    blocked = _quota_block(tenant)
    if blocked:
        return blocked
    try:
        refinement = run_autoconfigure(body.brief or {}, body.draft or {}, body.rationale or "")
        if result_cache.enabled():
            result_cache.get_cache().set(ck, refinement)
        return {"ok": True, "refinement": refinement, "cached": False}
    except Exception:  # noqa: BLE001 — surface a clean message; frontend degrades
        log.exception("autoconfigure failed")
        return {"ok": False, "error": "autoconfigure failed"}


@app.post("/judge")
@limiter.limit(os.getenv("JUDGE_RATE_LIMIT", os.getenv("MAP_BUDDY_RATE_LIMIT", "60/minute")))
def judge(request: Request, body: JudgeRequest):
    """LLM-judge grounding gate (C5 / DIC-586). Scores whether an AI output is grounded in
    the deterministic truth + whether its citations are accurate. Returns {ok, verdict:
    {grounded, citations_ok, issues}} or {ok:false, error}."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"ok": False, "error": "ANTHROPIC_API_KEY not configured."}
    too_big = _payload_too_large({"output": body.output, "grounding": body.grounding})
    if too_big:
        return too_big
    tenant = SERVER_TENANT
    ck = result_cache.cache_key("judge", tenant, {"output": body.output, "grounding": body.grounding})
    if result_cache.enabled():
        hit = result_cache.get_cache().get(ck)
        if hit is not None:
            return {"ok": True, "verdict": hit, "cached": True}
    blocked = _quota_block(tenant)
    if blocked:
        return blocked
    try:
        verdict = run_grounding_judge(body.output or "", body.grounding or {})
        if result_cache.enabled():
            result_cache.get_cache().set(ck, verdict)
        return {"ok": True, "verdict": verdict, "cached": False}
    except Exception:  # noqa: BLE001 — clean message; caller degrades
        log.exception("judge failed")
        return {"ok": False, "error": "judge failed"}


@app.post("/describe-cohort")
@limiter.limit(os.getenv("DESCRIBE_COHORT_RATE_LIMIT", os.getenv("MAP_BUDDY_RATE_LIMIT", "60/minute")))
def describe_cohort(request: Request, body: DescribeCohortRequest):
    """AI 'character' read over a Neighborhood / Area Profile (DIC-588). The engine core
    already computed the deterministic facts; the model only characterizes them in plain
    language, never originating a number. Returns {ok, narration:{headline, character,
    paragraphs, caveats}} or {ok:false, error} so the Profile degrades to its dashboard
    (facts-parity §4.6). Reuses the C3 cache + per-tenant quota like the other AI routes."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"ok": False, "error": "ANTHROPIC_API_KEY not configured."}
    facts = body.facts or {}
    too_big = _payload_too_large(facts)
    if too_big:
        return too_big
    tenant = SERVER_TENANT
    ck = result_cache.cache_key("describe-cohort", tenant, facts)
    if result_cache.enabled():
        hit = result_cache.get_cache().get(ck)
        if hit is not None:
            return {"ok": True, "narration": hit, "cached": True}
    blocked = _quota_block(tenant)
    if blocked:
        return blocked
    try:
        narration = run_describe_cohort(facts)
        if result_cache.enabled():
            result_cache.get_cache().set(ck, narration)
        return {"ok": True, "narration": narration, "cached": False}
    except Exception:  # noqa: BLE001 — clean message; the Profile degrades to facts
        log.exception("describe-cohort failed")
        return {"ok": False, "error": "describe-cohort failed"}


@app.post("/kb/resolve")
@limiter.limit(os.getenv("KB_RATE_LIMIT", os.getenv("MAP_BUDDY_RATE_LIMIT", "120/minute")))
def kb_resolve(request: Request, body: KbResolveRequest):
    """Resolve a §6.4 citation envelope against the County Knowledge Base (DIC-522), so the
    viewer's Sources panel can show full section text + a precise passage. NOT AI — pure
    retrieval, so there is NO ANTHROPIC_API_KEY gate (citations must work AI-off). Returns
    {ok, doc} on a hit, {ok:false} when the KB is unavailable or has nothing citable — the
    viewer then degrades to its curated-statute resolver (honest 'coarse'/'none')."""
    store = _KB_STORE
    # A request may scope to a different tenant than the default store (fail-closed inside
    # the store if the jurisdiction is unknown/empty). Rebuild only when it differs.
    if body.jurisdiction and (store is None or getattr(store, "jurisdiction", None) != body.jurisdiction):
        try:
            store = kb_resolver.build_kb_store(jurisdiction=body.jurisdiction)
        except Exception:  # noqa: BLE001 — degrade, don't 500
            store = None
    if store is None:
        return {"ok": False, "error": "knowledge base unavailable"}
    try:
        doc = kb_resolver.resolve_envelope(store, body.envelope or {}, domain=body.domain)
    except Exception:  # noqa: BLE001 — clean message; viewer falls back
        log.exception("kb resolve failed")
        return {"ok": False, "error": "kb resolve failed"}
    if not doc:
        return {"ok": False, "error": "no citable source in the knowledge base"}
    return {"ok": True, "doc": doc}


@app.get("/explainers")
async def explainers():
    """Explainer-plugin catalog for the Admin Console (DIC-459) — each plugin's
    model, system prompt, and injected context blocks. Read-only; no model call,
    no secrets."""
    return {"explainers": explainer_profiles_public()}


@app.get("/workflows")
async def workflows():
    """Catalog of available macros for the Automations palette (DIC-432). Driven
    by the macro registry, so a new macro appears here automatically. No model."""
    return {"workflows": [
        {"id": k, "description": v["description"], "params": v.get("params", {})}
        for k, v in WORKFLOWS.items()
    ]}


@app.post("/workflow")
@limiter.limit(os.getenv("MAP_BUDDY_RATE_LIMIT", "120/minute"))
def run_workflow(request: Request, body: WorkflowRequest):
    """Deterministically expand a macro into map commands — one tap, no model
    round-trip. Returns the same {commands} the chat's run_workflow would."""
    inp = dict(body.params or {})
    inp["pin"] = body.pin
    ctx = body.parcel_context.model_dump() if body.parcel_context else None
    note, commands = _expand_workflow(body.workflow, inp, ctx)
    return {"commands": commands, "note": note}
