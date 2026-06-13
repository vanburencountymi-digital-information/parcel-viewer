"""Map Buddy agent — Anthropic-backed chat with map command tool use."""

import json
import os
import anthropic

_client = None

def _get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


DEFAULT_SYSTEM = """You are Map Buddy, a friendly AI assistant embedded in a parcel map viewer for Van Buren County, Michigan. You help users understand parcel data, navigate the map, and answer questions about land, zoning, ownership, and local geography.

When a parcel is selected you will receive its basic data (PIN, acreage, owner, address, municipality). Use this as your primary context. If no parcel is selected, help the user navigate or answer general questions about the county.

You can control the map using the available tools. Use them when they would genuinely help — for example, zoom to a parcel the user is asking about, or toggle a relevant overlay layer.

Be concise and conversational. This is a map panel, not a research paper."""

SYSTEM_PROMPT = os.getenv("MAP_BUDDY_SYSTEM_PROMPT", DEFAULT_SYSTEM)

TOOLS = [
    {
        "name": "fit_map_to_parcel",
        "description": "Zoom and pan the map to fit the currently selected parcel in view.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "highlight_parcel",
        "description": "Visually highlight a parcel on the map by PIN.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pin": {"type": "string", "description": "The parcel identification number to highlight"}
            },
            "required": ["pin"],
        },
    },
    {
        "name": "select_parcel_on_map",
        "description": "Select a parcel on the map by PIN, loading its data into the info panel.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pin": {"type": "string", "description": "The parcel identification number to select"}
            },
            "required": ["pin"],
        },
    },
    {
        "name": "set_layer_visibility",
        "description": "Show or hide a map overlay layer.",
        "input_schema": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "Layer identifier. Available layers: aerial, floodplain, wetlands, contours",
                },
                "visible": {"type": "boolean", "description": "True to show, false to hide"},
            },
            "required": ["layer_id", "visible"],
        },
    },
]


def _build_user_message(message: str, parcel_context: dict | None, history: list[dict]) -> list[dict]:
    messages = list(history)

    content = message
    if parcel_context:
        ctx_lines = ["Currently selected parcel:"]
        if parcel_context.get("pin"):
            ctx_lines.append(f"  PIN: {parcel_context['pin']}")
        if parcel_context.get("site_address"):
            ctx_lines.append(f"  Address: {parcel_context['site_address']}")
        if parcel_context.get("owner_name"):
            ctx_lines.append(f"  Owner: {parcel_context['owner_name']}")
        if parcel_context.get("acres") is not None:
            ctx_lines.append(f"  Acres: {parcel_context['acres']:.2f}")
        if parcel_context.get("municipality"):
            ctx_lines.append(f"  Municipality: {parcel_context['municipality']}")
        content = "\n".join(ctx_lines) + "\n\n" + message

    messages.append({"role": "user", "content": content})
    return messages


def run_chat_stream(message: str, history: list, parcel_context):
    """Generator yielding SSE-compatible event dicts."""
    yield {"type": "status", "message": "Thinking…"}

    ctx = parcel_context.model_dump() if parcel_context else None
    hist = [{"role": m.role, "content": m.content} for m in history]
    messages = _build_user_message(message, ctx, hist)

    try:
        response = _get_client().messages.create(
            model=os.getenv("MAP_BUDDY_MODEL", "claude-haiku-4-5-20251001"),
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )
    except Exception as e:
        yield {"type": "error", "message": str(e)}
        return

    # Collect text and tool-use blocks
    response_text = ""
    commands = []

    for block in response.content:
        if block.type == "text":
            response_text = block.text
        elif block.type == "tool_use":
            name = block.name
            inp = block.input or {}
            if name == "fit_map_to_parcel":
                commands.append({"type": "fit_map_to_parcel", "payload": {}})
            elif name == "highlight_parcel":
                commands.append({"type": "highlight_parcel", "payload": {"pin": inp.get("pin")}})
            elif name == "select_parcel_on_map":
                commands.append({"type": "select_parcel_on_map", "payload": {"pin": inp.get("pin")}})
            elif name == "set_layer_visibility":
                commands.append({
                    "type": "set_layer_visibility",
                    "payload": {"layer_id": inp.get("layer_id"), "visible": inp.get("visible")},
                })

    yield {"type": "done", "response_text": response_text, "commands": commands}
