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


DEFAULT_SYSTEM = """You are Map Buddy, a sharp, friendly AI assistant embedded in an interactive MapLibre parcel viewer for Van Buren County, Michigan. You help people understand parcels and you *drive the map for them* — navigating, drawing, measuring, and toggling layers so they can see the answer, not just read it.

# Be proactive with the map
When a request has a spatial answer, SHOW it — don't just describe it. "Where is this parcel?" → zoom to it. "Is it in a floodplain?" → turn on the flood layer and zoom in. "How big is the back yard setback?" → draw the setback ring. You can call MULTIPLE tools in a single reply to compose an action (e.g. select a parcel, zoom to it, AND draw a buffer). Prefer doing over explaining.

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
- Search: search_parcels (by PIN, owner, or address — selects it if there's a single match).
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
    {"name": "select_parcel", "description": "Select a parcel by PIN, loading it into the info panel and making it the active context.",
     "input_schema": {"type": "object", "properties": {"pin": {"type": "string"}}, "required": ["pin"]}},
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

    # ── Search ────────────────────────────────────────────────────────────────
    {"name": "search_parcels", "description": "Search parcels by PIN, owner name, or address. Auto-selects and flies to a single match; lists clickable results for several.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},

    # ── Showcase ──────────────────────────────────────────────────────────────
    {"name": "map_tour", "description": "Run a guided fly-through of several stops, pausing at each. Each stop is a parcel PIN or a coordinate, with an optional note.",
     "input_schema": {"type": "object", "properties": {"stops": {"type": "array", "items": {"type": "object", "properties": {
         "pin": {"type": "string"}, "lng": _LNG, "lat": _LAT, "zoom": {"type": "number"}, "note": {"type": "string"}}}}}, "required": ["stops"]}},
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


def run_chat_stream(message: str, history: list, parcel_context, map_state=None):
    """Generator yielding SSE-compatible event dicts."""
    yield {"type": "status", "message": "Thinking…"}

    ctx = parcel_context.model_dump() if parcel_context else None
    hist = [{"role": m.role, "content": m.content} for m in history]
    messages = _build_user_message(message, ctx, map_state, hist)

    try:
        response = _get_client().messages.create(
            model=os.getenv("MAP_BUDDY_MODEL", "claude-sonnet-4-6"),
            max_tokens=int(os.getenv("MAP_BUDDY_MAX_TOKENS", "2048")),
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )
    except Exception as e:
        yield {"type": "error", "message": str(e)}
        return

    # Collect text and tool-use blocks. Tool names map 1:1 to frontend command
    # types, so we forward the tool input verbatim as the command payload — the
    # browser resolves geometry and drives the map.
    response_text = ""
    commands = []
    for block in response.content:
        if block.type == "text":
            response_text += block.text
        elif block.type == "tool_use":
            commands.append({"type": block.name, "payload": dict(block.input or {})})

    yield {"type": "done", "response_text": response_text, "commands": commands}
