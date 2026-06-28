"""Map Buddy microservice — standalone FastAPI backend for the Map Buddy AI assistant."""

import json
import os
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env", override=True)

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
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


def _quota_block(tenant):
    """If the tenant is over its AI quota, return a degrade-to-AI-off response (C3 /
    DIC-584); the viewer falls back to facts (B4). Returns None when the call may proceed.
    Call AFTER the cache check (cache hits are free) and BEFORE the model call."""
    allowed, remaining = ai_usage.allow(tenant)
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
app = FastAPI(title="Map Buddy Service", version="0.1.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

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
    role: str
    content: str


class MapState(BaseModel):
    center: list | None = None
    zoom: float | None = None
    bearing: float | None = None
    pitch: float | None = None
    visible_layers: list | None = None
    # Live layer registry (DIC-327): [{id, label, type, visible, fields}, ...].
    layers: list | None = None


class ChatRequest(BaseModel):
    message: str
    conversation_history: list[ChatMessage] = []
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

    def stream():
        ms = body.map_state.model_dump() if body.map_state else None
        for event in run_chat_stream(body.message, body.conversation_history, body.parcel_context, ms):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/explain")
@limiter.limit(os.getenv("EXPLAIN_RATE_LIMIT", os.getenv("MAP_BUDDY_RATE_LIMIT", "60/minute")))
async def explain(request: Request, body: ExplainRequest):
    """Generate a grounded, structured explanation for a parcel (DIC-370). The
    caller passes pre-verified figures; the model only narrates them. Returns
    {ok, explanation} or {ok: false, error} so the frontend can fall back to the
    static educational stub when the key/service is unavailable."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"ok": False, "error": "ANTHROPIC_API_KEY not configured."}
    facts = body.facts or {}
    # C3 result cache: the same parcel explained twice shouldn't pay twice. Tenant-scoped.
    tenant = facts.get("tenant") or facts.get("county")
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
        ai_usage.record(tenant)
        if result_cache.enabled():
            result_cache.get_cache().set(ck, explanation)
        return {"ok": True, "explanation": explanation, "cached": False}
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001 — surface a clean message; frontend degrades
        return {"ok": False, "error": f"explainer failed: {e}"}


@app.post("/autoconfigure")
@limiter.limit(os.getenv("AUTOCONFIGURE_RATE_LIMIT", os.getenv("MAP_BUDDY_RATE_LIMIT", "60/minute")))
async def autoconfigure(request: Request, body: AutoconfigureRequest):
    """AI refinement for the Theme Composer (B3 / DIC-579). The engine assembled a
    deterministic draft; the model adds a plain-language rationale + optional suggested
    tweaks over it, never changing the manifest. Returns {ok, refinement:{rationale,
    suggestions}} or {ok:false, error} so the console degrades to the baseline draft."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"ok": False, "error": "ANTHROPIC_API_KEY not configured."}
    if not body.draft:
        return {"ok": False, "error": "no draft manifest to refine."}
    tenant = (body.draft or {}).get("tenant") or (body.brief or {}).get("tenant")
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
        ai_usage.record(tenant)
        if result_cache.enabled():
            result_cache.get_cache().set(ck, refinement)
        return {"ok": True, "refinement": refinement, "cached": False}
    except Exception as e:  # noqa: BLE001 — surface a clean message; frontend degrades
        return {"ok": False, "error": f"autoconfigure failed: {e}"}


@app.post("/judge")
@limiter.limit(os.getenv("JUDGE_RATE_LIMIT", os.getenv("MAP_BUDDY_RATE_LIMIT", "60/minute")))
async def judge(request: Request, body: JudgeRequest):
    """LLM-judge grounding gate (C5 / DIC-586). Scores whether an AI output is grounded in
    the deterministic truth + whether its citations are accurate. Returns {ok, verdict:
    {grounded, citations_ok, issues}} or {ok:false, error}."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"ok": False, "error": "ANTHROPIC_API_KEY not configured."}
    tenant = (body.grounding or {}).get("tenant") or (body.grounding or {}).get("county")
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
        ai_usage.record(tenant)
        if result_cache.enabled():
            result_cache.get_cache().set(ck, verdict)
        return {"ok": True, "verdict": verdict, "cached": False}
    except Exception as e:  # noqa: BLE001 — clean message; caller degrades
        return {"ok": False, "error": f"judge failed: {e}"}


@app.post("/describe-cohort")
@limiter.limit(os.getenv("DESCRIBE_COHORT_RATE_LIMIT", os.getenv("MAP_BUDDY_RATE_LIMIT", "60/minute")))
async def describe_cohort(request: Request, body: DescribeCohortRequest):
    """AI 'character' read over a Neighborhood / Area Profile (DIC-588). The engine core
    already computed the deterministic facts; the model only characterizes them in plain
    language, never originating a number. Returns {ok, narration:{headline, character,
    paragraphs, caveats}} or {ok:false, error} so the Profile degrades to its dashboard
    (facts-parity §4.6). Reuses the C3 cache + per-tenant quota like the other AI routes."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"ok": False, "error": "ANTHROPIC_API_KEY not configured."}
    facts = body.facts or {}
    tenant = facts.get("tenant") or facts.get("county")
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
        ai_usage.record(tenant)
        if result_cache.enabled():
            result_cache.get_cache().set(ck, narration)
        return {"ok": True, "narration": narration, "cached": False}
    except Exception as e:  # noqa: BLE001 — clean message; the Profile degrades to facts
        return {"ok": False, "error": f"describe-cohort failed: {e}"}


@app.post("/kb/resolve")
@limiter.limit(os.getenv("KB_RATE_LIMIT", os.getenv("MAP_BUDDY_RATE_LIMIT", "120/minute")))
async def kb_resolve(request: Request, body: KbResolveRequest):
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
    except Exception as e:  # noqa: BLE001 — clean message; viewer falls back
        return {"ok": False, "error": f"kb resolve failed: {e}"}
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
async def run_workflow(request: Request, body: WorkflowRequest):
    """Deterministically expand a macro into map commands — one tap, no model
    round-trip. Returns the same {commands} the chat's run_workflow would."""
    inp = dict(body.params or {})
    inp["pin"] = body.pin
    ctx = body.parcel_context.model_dump() if body.parcel_context else None
    note, commands = _expand_workflow(body.workflow, inp, ctx)
    return {"commands": commands, "note": note}
