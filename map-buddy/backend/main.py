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

from agent import run_chat_stream, WORKFLOWS, _expand_workflow

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
