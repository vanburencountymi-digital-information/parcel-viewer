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

from agent import run_chat_stream, WORKFLOWS, _expand_workflow, run_explain, run_autoconfigure, run_grounding_judge, explainer_profiles_public
import cache as result_cache

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


@app.get("/health")
async def health():
    return {"status": "ok"}


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
    try:
        explanation = run_explain(body.topic, facts)
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
    try:
        refinement = run_autoconfigure(body.brief or {}, body.draft or {}, body.rationale or "")
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
    try:
        verdict = run_grounding_judge(body.output or "", body.grounding or {})
        if result_cache.enabled():
            result_cache.get_cache().set(ck, verdict)
        return {"ok": True, "verdict": verdict, "cached": False}
    except Exception as e:  # noqa: BLE001 — clean message; caller degrades
        return {"ok": False, "error": f"judge failed: {e}"}


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
