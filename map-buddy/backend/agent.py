"""Map Buddy agent — Anthropic-backed chat with map command tool use."""

import json
import os
import urllib.parse
import urllib.request
import anthropic

_client = None

def _get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


DEFAULT_SYSTEM = """You are Map Buddy, a sharp, friendly AI assistant embedded in an interactive MapLibre parcel viewer for Van Buren County, Michigan. You help people understand parcels and you *drive the map for them* — navigating, drawing, measuring, and toggling layers so they can see the answer, not just read it.

# Be proactive — do the whole job, then offer the next one
When a request has a spatial answer, SHOW it — don't just describe it. "Where is this parcel?" → zoom to it. "Is it in a floodplain?" → turn on the flood layer and zoom in. You can (and should) call MULTIPLE tools in a single reply to compose a complete action.

Treat broad asks as WORKFLOWS and run the whole thing in one reply, don't make the user ask step by step:
- "Tell me about / analyze / what's the rundown on this parcel" → fly to it, turn on flood + wetlands, measure it, and give a 2-3 sentence summary of size, risk, and ownership.
- "Is it buildable / what can I build" → draw the setback ring, place a sample footprint, and summarize the buildable area.
- "What's the risk here" → turn on flood + wetlands (and soils if relevant), zoom in, and summarize what you see.

After acting, ALWAYS call `suggest_actions` with 2-4 tailored next steps the user might want, phrased as taps (e.g. "Show the 100-year floodplain", "Compare to the parcel next door", "Drop a 40×30 house"). This is how the user discovers what you can do — never leave them at a dead end.

# Context you receive
- The currently selected parcel (PIN, owner, address, acreage, municipality) plus its **centroid [lng, lat]** and **bbox**. Use the centroid as the anchor point for circles, buffers, structures, and labels on that parcel.
- The **current map view**: center [lng, lat], zoom, bearing, pitch, and which overlay layers are visible. Use the map center when the user refers to "here" / "this area".

# Coordinate rules (important)
- All coordinates are [longitude, latitude] in WGS84 decimal degrees.
- ONLY use coordinates you were given (parcel centroid/bbox, map center) or that the user provides. NEVER invent coordinates for a named place you don't have coordinates for — instead use search_parcels, or ask. Distances and dimensions are in FEET.

# Tools at your disposal
- Camera: fly_to_parcel, fly_to_coordinates, zoom_to, zoom_by, set_pitch (3-D tilt 0-85°), set_bearing (rotate), reset_north, fit_map_to_parcel, fit_to_annotations.
- Selection: select_parcel, highlight_parcel.
- Layers: set_layer_visibility (flood, wetlands, soils, hillshade, contours).
- Drawing: draw_point, draw_line, draw_polygon, draw_circle, label_point, label_parcel_centroid, draw_parcel_buffer (inward = setback), place_structure_in_parcel, clear_annotations.
- Measurement: measure_parcel, measure_area, measure_distance (results are shown to the user automatically).
- Built-in viewer tools: set_parcel_labels (label every parcel by owner/PIN/address/value), dimension_parcel (surveyor-style side dimensions), activate_draw_tool (hand the user a draw tool), undo, redo.
- Open viewer windows: open_tool — the Parcel Packet report ('packet'), Compare, Street View, the tax/assessment explainers, print/share/bookmark/settings, etc. "Show me the parcel packet" → select the parcel if needed, then open_tool 'packet'.
- Data lookups (results come back to you): search_parcels finds parcels across the whole county by owner/address/PIN; get_parcel_info pulls a full record by id. For "find X and do Y": call search_parcels, then select_parcel with the best match's `id`, then act (you have the tool results, so do it all). If several plausible matches, ask which one.
- Showcase: map_tour for a guided fly-through of several stops.

# Style
Be concise and conversational — this is a side panel, not a report. Use light Markdown (bold, short bullet lists). After you act on the map, a row of chips shows the user what you did, so you don't need to narrate every step — a one-line summary is plenty. If a request needs a parcel but none is selected and you can't find one, say so briefly."""

SYSTEM_PROMPT = os.getenv("MAP_BUDDY_SYSTEM_PROMPT", DEFAULT_SYSTEM)

# Tool names map 1:1 to frontend command types (see _runCommands in
# map-buddy/js/map-buddy.js). The backend just forwards {name, input} → command;
# the browser resolves geometry and drives the map.
_LNG = {"type": "number", "description": "Longitude (WGS84 decimal degrees)"}
_LAT = {"type": "number", "description": "Latitude (WGS84 decimal degrees)"}
_PIN = {"type": "string", "description": "Parcel identification number (PIN). Omit to use the selected parcel."}
_COORDS = {
    "type": "array",
    "description": "Ordered list of [longitude, latitude] points.",
    "items": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
}

TOOLS = [
    # ── Camera ────────────────────────────────────────────────────────────────
    {"name": "fly_to_parcel", "description": "Smoothly zoom and pan the map to frame a parcel. Defaults to the selected parcel.",
     "input_schema": {"type": "object", "properties": {"pin": _PIN}, "required": []}},
    {"name": "fly_to_coordinates", "description": "Fly the map to a specific point. Use the map center or a parcel centroid you were given — never an invented location.",
     "input_schema": {"type": "object", "properties": {"lng": _LNG, "lat": _LAT, "zoom": {"type": "number", "description": "Optional target zoom (10-19)"}}, "required": ["lng", "lat"]}},
    {"name": "zoom_to", "description": "Set the map zoom level (10 = county, 16 = parcel, 19 = rooftop).",
     "input_schema": {"type": "object", "properties": {"zoom": {"type": "number"}}, "required": ["zoom"]}},
    {"name": "zoom_by", "description": "Zoom in (+) or out (-) by a number of levels relative to the current view.",
     "input_schema": {"type": "object", "properties": {"delta": {"type": "number", "description": "e.g. 1 to zoom in, -2 to zoom out two levels"}}, "required": ["delta"]}},
    {"name": "set_pitch", "description": "Tilt the camera for a 3-D perspective. 0 = straight down (2-D), 60 = strong 3-D tilt. Great with hillshade.",
     "input_schema": {"type": "object", "properties": {"pitch": {"type": "number", "description": "Degrees, 0-85"}}, "required": ["pitch"]}},
    {"name": "set_bearing", "description": "Rotate the map to a compass bearing (0 = north up, 90 = east up).",
     "input_schema": {"type": "object", "properties": {"bearing": {"type": "number", "description": "Degrees, 0-359"}}, "required": ["bearing"]}},
    {"name": "reset_north", "description": "Reset the map to north-up and remove any 3-D tilt.",
     "input_schema": {"type": "object", "properties": {}, "required": []}},
    {"name": "fit_map_to_parcel", "description": "Fit the currently selected parcel neatly in view.",
     "input_schema": {"type": "object", "properties": {}, "required": []}},
    {"name": "fit_to_annotations", "description": "Zoom/pan to fit all currently drawn annotations in view.",
     "input_schema": {"type": "object", "properties": {}, "required": []}},

    # ── Selection ─────────────────────────────────────────────────────────────
    {"name": "select_parcel", "description": "Select a parcel, loading it into the info panel and making it the active context. Prefer the `id` from a search result (works for any parcel in the county); a bare PIN only resolves parcels currently on screen.",
     "input_schema": {"type": "object", "properties": {"id": {"type": ["integer", "string"], "description": "Parcel DB id from a search_parcels result"}, "pin": {"type": "string"}}, "required": []}},
    {"name": "highlight_parcel", "description": "Flash and highlight a parcel by PIN without changing the selection.",
     "input_schema": {"type": "object", "properties": {"pin": {"type": "string"}}, "required": ["pin"]}},

    # ── Layers ────────────────────────────────────────────────────────────────
    {"name": "set_layer_visibility", "description": "Show or hide a map overlay layer.",
     "input_schema": {"type": "object", "properties": {
         "layer_id": {"type": "string", "enum": ["flood", "wetlands", "soils", "hillshade", "contours", "contours-5ft", "contours-2ft"],
                      "description": "flood = FEMA flood hazard, wetlands = USFWS NWI, soils = USDA SSURGO, hillshade = USGS terrain, contours = 10ft elevation contours"},
         "visible": {"type": "boolean"}}, "required": ["layer_id", "visible"]}},

    # ── Drawing ───────────────────────────────────────────────────────────────
    {"name": "draw_point", "description": "Drop a point marker. Optional label and hex color.",
     "input_schema": {"type": "object", "properties": {"lng": _LNG, "lat": _LAT, "label": {"type": "string"}, "color": {"type": "string"}}, "required": ["lng", "lat"]}},
    {"name": "draw_line", "description": "Draw a polyline through a list of points.",
     "input_schema": {"type": "object", "properties": {"coordinates": _COORDS, "label": {"type": "string"}, "color": {"type": "string"}}, "required": ["coordinates"]}},
    {"name": "draw_polygon", "description": "Draw a filled polygon from a list of points (the ring is auto-closed).",
     "input_schema": {"type": "object", "properties": {"coordinates": _COORDS, "label": {"type": "string"}, "color": {"type": "string"}, "fill_color": {"type": "string"}}, "required": ["coordinates"]}},
    {"name": "draw_circle", "description": "Draw a circle of a given radius in feet around a center point.",
     "input_schema": {"type": "object", "properties": {"lng": _LNG, "lat": _LAT, "radius_ft": {"type": "number"}, "label": {"type": "string"}, "color": {"type": "string"}}, "required": ["lng", "lat", "radius_ft"]}},
    {"name": "label_point", "description": "Place a text label at a point.",
     "input_schema": {"type": "object", "properties": {"lng": _LNG, "lat": _LAT, "text": {"type": "string"}}, "required": ["lng", "lat", "text"]}},
    {"name": "label_parcel_centroid", "description": "Place a text label at the center of a parcel.",
     "input_schema": {"type": "object", "properties": {"pin": _PIN, "text": {"type": "string"}}, "required": ["text"]}},
    {"name": "draw_parcel_buffer", "description": "Draw a buffer (outward) or setback (inward) ring around a parcel boundary at a distance in feet.",
     "input_schema": {"type": "object", "properties": {"pin": _PIN, "distance_ft": {"type": "number"}, "inward": {"type": "boolean", "description": "true = inward setback, false = outward buffer"}, "label": {"type": "string"}}, "required": ["distance_ft"]}},
    {"name": "place_structure_in_parcel", "description": "Place a rectangular building footprint (feet) at the center of a parcel.",
     "input_schema": {"type": "object", "properties": {"pin": _PIN, "width_ft": {"type": "number"}, "depth_ft": {"type": "number"}, "rotation_deg": {"type": "number"}, "label": {"type": "string"}}, "required": ["width_ft", "depth_ft"]}},
    {"name": "clear_annotations", "description": "Remove all drawings (buffers, circles, labels, lines) from the map.",
     "input_schema": {"type": "object", "properties": {}, "required": []}},

    # ── Measurement (results are shown to the user automatically) ──────────────
    {"name": "measure_parcel", "description": "Report a parcel's area, perimeter, and estimated dimensions.",
     "input_schema": {"type": "object", "properties": {"pin": _PIN}, "required": []}},
    {"name": "measure_area", "description": "Measure the area and perimeter of a polygon.",
     "input_schema": {"type": "object", "properties": {"coordinates": _COORDS}, "required": ["coordinates"]}},
    {"name": "measure_distance", "description": "Measure the total distance along a path.",
     "input_schema": {"type": "object", "properties": {"coordinates": _COORDS}, "required": ["coordinates"]}},

    # ── Data lookups (resolved server-side; results return to you) ────────────
    {"name": "search_parcels", "description": "Search the FULL county parcel database by PIN, owner name, or address. Returns matching parcels with their id, pin, owner, address, and acres. This is how you find a parcel the user names that isn't on screen — then pass a result's `id` to select_parcel to act on it.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]}},
    {"name": "get_parcel_info", "description": "Fetch the full record for a parcel by its DB `id` (owner, address, acreage, assessed/taxable/market values, class, zoning). Use after search_parcels when you need details to answer a question.",
     "input_schema": {"type": "object", "properties": {"id": {"type": ["integer", "string"]}}, "required": ["id"]}},

    # ── Built-in map tools (the viewer's own tooling) ─────────────────────────
    {"name": "set_parcel_labels", "description": "Turn on on-map parcel labels and choose what they show across the whole map. Use for 'label parcels with owner names', 'show PINs', 'label by assessed value', etc.",
     "input_schema": {"type": "object", "properties": {
         "field": {"type": "string", "enum": ["owner", "pin", "address", "av", "sev", "tv", "tmv", "tmv_acre", "zoning", "class"],
                   "description": "owner = owner name; av/sev/tv/tmv = assessed/SEV/taxable/market value; tmv_acre = market value per acre"},
         "visible": {"type": "boolean", "description": "true to show (default), false to hide labels"},
         "size": {"type": "string", "enum": ["small", "medium", "large"]}}, "required": ["field"]}},
    {"name": "dimension_parcel", "description": "Auto-label every side of a parcel with its length and bearing, surveyor-style (uses the viewer's Auto-Dimension tool). Defaults to the selected parcel.",
     "input_schema": {"type": "object", "properties": {"pin": _PIN}, "required": []}},
    {"name": "activate_draw_tool", "description": "Hand the user an interactive drawing tool so THEY can sketch on the map (use when the user wants to draw something themselves, then you can measure it). Optional color.",
     "input_schema": {"type": "object", "properties": {
         "tool": {"type": "string", "enum": ["point", "polyline", "polygon", "circle", "freehand", "text", "callout", "select"]},
         "color": {"type": "string"}, "fill_color": {"type": "string"}}, "required": ["tool"]}},
    {"name": "undo", "description": "Undo the last drawing/annotation action.", "input_schema": {"type": "object", "properties": {}, "required": []}},
    {"name": "redo", "description": "Redo the last undone drawing/annotation action.", "input_schema": {"type": "object", "properties": {}, "required": []}},
    {"name": "open_tool", "description": "Open one of the viewer's built-in tools/windows for the user. Parcel tools (a parcel must be selected first): 'packet' = the full Parcel Packet report, 'compare' = compare parcels, 'streetview' = Street View. Explainer windows: 'tax' = tax-description breakdown, 'assess' = assessment & tax breakdown. App tools: 'print', 'share', 'bookmark', 'data-request', 'report-error', 'help', 'whats-new', 'about', 'settings'. For 'show me the parcel packet', select the parcel if needed then open 'packet'.",
     "input_schema": {"type": "object", "properties": {"tool": {"type": "string", "enum": ["packet", "compare", "streetview", "tax", "assess", "print", "share", "bookmark", "data-request", "report-error", "help", "whats-new", "about", "settings"]}}, "required": ["tool"]}},

    # ── Showcase ──────────────────────────────────────────────────────────────
    {"name": "map_tour", "description": "Run a guided fly-through of several stops, pausing at each. Each stop is a parcel PIN or a coordinate, with an optional note.",
     "input_schema": {"type": "object", "properties": {"stops": {"type": "array", "items": {"type": "object", "properties": {
         "pin": {"type": "string"}, "lng": _LNG, "lat": _LAT, "zoom": {"type": "number"}, "note": {"type": "string"}}}}}, "required": ["stops"]}},

    # ── Proactive offers ──────────────────────────────────────────────────────
    {"name": "suggest_actions", "description": "Offer the user 2-4 helpful next steps as tappable suggestions so they don't have to know what to ask. Each is a short, natural first-person-imperative phrase the user could tap (e.g. 'Show flood & wetlands risk', 'Draw a 30 ft setback', 'Compare to the neighboring parcel'). Call this at the END of almost every reply, tailored to the current parcel/context.",
     "input_schema": {"type": "object", "properties": {"suggestions": {"type": "array", "items": {"type": "string"}, "maxItems": 4}}, "required": ["suggestions"]}},
]


def _build_user_message(
    message: str, parcel_context: dict | None, map_state: dict | None, history: list[dict]
) -> list[dict]:
    messages = list(history)

    blocks = []
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
        if parcel_context.get("centroid"):
            ctx_lines.append(f"  Centroid [lng, lat]: {parcel_context['centroid']}")
        if parcel_context.get("bbox"):
            ctx_lines.append(f"  BBox [w, s, e, n]: {parcel_context['bbox']}")
        blocks.append("\n".join(ctx_lines))

    if map_state:
        ms_lines = ["Current map view:"]
        if map_state.get("center"):
            ms_lines.append(f"  Center [lng, lat]: {map_state['center']}")
        if map_state.get("zoom") is not None:
            ms_lines.append(f"  Zoom: {map_state['zoom']}")
        if map_state.get("bearing") is not None:
            ms_lines.append(f"  Bearing: {map_state['bearing']}°")
        if map_state.get("pitch") is not None:
            ms_lines.append(f"  Pitch: {map_state['pitch']}°")
        layers = map_state.get("visible_layers") or []
        ms_lines.append(f"  Visible overlays: {', '.join(layers) if layers else 'none'}")
        blocks.append("\n".join(ms_lines))

    content = ("\n\n".join(blocks) + "\n\n" + message) if blocks else message
    messages.append({"role": "user", "content": content})
    return messages


# Map-control tools execute in the BROWSER, so the backend can't return real
# results. We hand the model a short synthetic acknowledgement per tool so it can
# continue the turn — string several actions together, then write a summary and
# offer next steps — rather than stopping after the first batch of tool calls.
# A couple of tools resolve real data instead of driving the map. We run these
# server-side against the main Parcel Viewer API and feed the result back into
# the loop, so the model can find a parcel the user names (even off-screen) and
# then act on it. PARCEL_API_BASE is the in-cluster API (http://api:8000) locally
# and the deployed API URL in prod.
PARCEL_API_BASE = os.getenv("PARCEL_API_BASE", "http://api:8000").rstrip("/")
DATA_TOOLS = {"search_parcels", "get_parcel_info"}


def _http_get_json(path: str):
    req = urllib.request.Request(PARCEL_API_BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def _exec_data_tool(name: str, inp: dict) -> str:
    try:
        if name == "search_parcels":
            q = (inp.get("query") or "").strip()
            if len(q) < 2:
                return "Query too short — need at least 2 characters."
            limit = min(int(inp.get("limit") or 8), 25)
            data = _http_get_json("/search?q=" + urllib.parse.quote(q) + "&limit=" + str(limit))
            results = data.get("results", [])
            if not results:
                return f"No parcels matched '{q}'."
            slim = [{"id": r.get("id"), "pin": r.get("pin"), "owner": r.get("owner_name"),
                     "address": r.get("address"), "municipality": r.get("municipality"),
                     "acres": r.get("acres")} for r in results]
            return json.dumps({"matches": slim})
        if name == "get_parcel_info":
            pid = inp.get("id") if inp.get("id") is not None else inp.get("parcel_id")
            if pid is None:
                return "Provide a parcel id (from search_parcels)."
            data = _http_get_json("/parcel/" + urllib.parse.quote(str(pid)))
            return json.dumps(data.get("properties", data))
    except Exception as e:
        return f"Lookup failed: {e}"
    return "Unknown data tool."


def _tool_ack(name: str) -> str:
    if name in ("measure_parcel", "measure_area", "measure_distance"):
        return "Measurement computed and shown to the user."
    if name == "search_parcels":
        return "Search ran; results are shown to the user, and a single match is auto-selected and centered."
    if name == "suggest_actions":
        return "Suggestions shown to the user."
    return "Done — the map was updated."


def run_chat_stream(message: str, history: list, parcel_context, map_state=None):
    """Generator yielding SSE-compatible event dicts.

    Runs a multi-turn agent loop: the model calls tools, we feed back synthetic
    acknowledgements (the browser does the real work), and it keeps going until
    it produces a final text turn — so a single user request can fan out into a
    whole workflow plus a summary and suggested next steps.
    """
    yield {"type": "status", "message": "Thinking…"}

    ctx = parcel_context.model_dump() if parcel_context else None
    hist = [{"role": m.role, "content": m.content} for m in history]
    messages = _build_user_message(message, ctx, map_state, hist)

    model = os.getenv("MAP_BUDDY_MODEL", "claude-sonnet-4-6")
    max_tokens = int(os.getenv("MAP_BUDDY_MAX_TOKENS", "2048"))
    max_iters = int(os.getenv("MAP_BUDDY_MAX_ITERS", "6"))

    response_text = ""
    commands = []
    try:
        for _ in range(max_iters):
            response = _get_client().messages.create(
                model=model, max_tokens=max_tokens,
                system=SYSTEM_PROMPT, tools=TOOLS, messages=messages,
            )
            messages.append({"role": "assistant", "content": response.content})

            tool_results = []
            for block in response.content:
                if block.type == "text":
                    response_text += block.text
                elif block.type == "tool_use":
                    inp = dict(block.input or {})
                    if block.name in DATA_TOOLS:
                        # Resolved server-side; the real data goes back to the
                        # model, not to the browser.
                        result = _exec_data_tool(block.name, inp)
                    else:
                        # Tool name maps 1:1 to a frontend command type; forward
                        # the input verbatim as the command payload.
                        commands.append({"type": block.name, "payload": inp})
                        result = _tool_ack(block.name)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result,
                    })

            if response.stop_reason != "tool_use" or not tool_results:
                break  # model produced a final (text) turn — done

            messages.append({"role": "user", "content": tool_results})
            yield {"type": "status", "message": "Working on it…"}
    except Exception as e:
        yield {"type": "error", "message": str(e)}
        return

    if commands and not response_text.strip():
        response_text = "Done — updated the map."

    yield {"type": "done", "response_text": response_text, "commands": commands}
