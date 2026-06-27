"""Map Buddy agent — Anthropic-backed chat with map command tool use."""

import json
import math
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

Prefer the **run_workflow** tool for these common combos (analyze_parcel, check_buildability, risk_overview): it runs the whole fixed sequence in one deterministic call and hands you the environmental data to summarize — faster and more reliable than chaining the steps yourself. Use individual tools only for custom requests.

After acting, ALWAYS call `suggest_actions` with 2-4 tailored next steps. Favor suggestions that trigger a rich multi-step action — a workflow (analyze_parcel / check_buildability / risk_overview), a cinematic fly-around, the Parcel Packet — over trivial single steps, so each tap does something substantial. Phrase them as taps (e.g. "Take a cinematic tour of this parcel", "Check buildability", "Compare to the parcel next door"). This is how the user discovers what you can do — never leave them at a dead end.

# Context you receive
- The currently selected parcel (PIN, owner, address, acreage, municipality) plus its **centroid [lng, lat]** and **bbox**. Use the centroid as the anchor point for circles, buffers, structures, and labels on that parcel.
- The **current map view**: center [lng, lat], zoom, bearing, pitch. Use the map center when the user refers to "here" / "this area".
- The **live layer state**: every map layer, whether it's currently ON or OFF, and the fields each data layer carries. This is real-time — it reflects exactly what the user is looking at right now.

# Use the live layer state
- "What am I looking at?" / "What layers are on?" → answer from the live layer state, naming the layers currently ON.
- Only claim data from a layer that is actually present. If answering needs a layer that's listed but OFF, turn it on (set_layer_visibility) or pulse_layer it, then answer — don't guess from memory.
- If the user asks about data no listed layer provides, say it isn't loaded rather than inventing it. When a layer's fields are shown, you can speak to exactly those attributes.

# Coordinate rules (important)
- All coordinates are [longitude, latitude] in WGS84 decimal degrees.
- ONLY use coordinates you were given (parcel centroid/bbox, map center) or that the user provides. NEVER invent coordinates for a named place you don't have coordinates for — instead use search_parcels, or ask. Distances and dimensions are in FEET.

# Tools at your disposal
- Camera: fly_to_parcel (quick frame), cinematic_fly_to_parcel (tilt-fly-orbit-return — use for "show me / fly to / take me to a parcel"), fly_to_coordinates, zoom_to, zoom_by, set_pitch (3-D tilt 0-85°), set_bearing (rotate), reset_north, fit_map_to_parcel, fit_to_annotations.
- Selection: select_parcel, highlight_parcel.
- Layers: set_layer_visibility (flood, wetlands, soils, hillshade, contours), pulse_layer (bloom a layer you're discussing — see Reactive cartography).
- Drawing: draw_point, draw_line, draw_polygon, draw_circle, label_point, label_parcel_centroid, draw_parcel_buffer (inward = setback), place_structure_in_parcel, clear_annotations.
- Measurement: measure_parcel, measure_area, measure_distance (results are shown to the user automatically).
- Built-in viewer tools: set_parcel_labels (label every parcel by owner/PIN/address/value), dimension_parcel (surveyor-style side dimensions), activate_draw_tool (hand the user a draw tool), undo, redo.
- Open viewer windows: open_tool — the Parcel Packet report ('packet'), Compare, Street View, the tax/assessment explainers, print/share/bookmark/settings, etc. "Show me the parcel packet" → select the parcel if needed, then open_tool 'packet'.
- Data lookups (results come back to you): search_parcels finds parcels across the whole county by owner/address/PIN; get_parcel_info pulls a full record by id; get_environmental_info returns the REAL flood zone / wetlands / soil at a point. For "find X and do Y": call search_parcels, then select_parcel with the best match's `id`, then act (you have the tool results, so do it all). If several plausible matches, ask which one.
- Interface: set_theme (dark/light), set_basemap (light/dark/aerial), set_base_layer (aerial/parcels), set_accessibility (large text, contrast, readable font, reduced motion/transparency, or max), set_panel_transparency, open_panel, set_area_units, set_coordinate_format, bookmark_current. Honor direct requests like "switch to dark mode", "turn on satellite", "make the text bigger".

# Answering environmental / risk questions
For "is this in a floodplain / are there wetlands / what's the soil / is it buildable", call get_environmental_info with the selected parcel's centroid and answer from the REAL result — never guess. It's good to ALSO turn on the matching overlay (flood/wetlands/soils) so the user sees it.
- Showcase: map_tour for a guided fly-through of several stops.

# Reactive cartography — make the map follow your words
The map reacts to focus, so what you *talk about* should light up:
- When your reply singles out a specific parcel, make sure it's the selected parcel (call select_parcel with its id) — the viewer then blooms it and dims everything else, so "this parcel" on screen matches "this parcel" in your text.
- When your reply mentions an overlay (floodplain, wetlands, soils, terrain, a county layer), call pulse_layer for it. That turns the layer on and gently pulses it so the eye lands where you're pointing. Use pulse_layer (not set_layer_visibility) when the goal is to draw attention to a layer you're describing.
- These effects self-gate on the user's Map-reactions setting and reduced-motion, so just call them naturally — they stay quiet when the user has turned reactions off.

# Style
Be concise and conversational — this is a side panel, not a report. Do NOT use emojis, emoticons, or decorative icons anywhere in replies or suggestions. Keep Markdown simple and consistent so it renders cleanly: short paragraphs separated by a blank line, "-" for bullets, **bold** for a key term or a short label line. Don't use tables or nested lists. After you act on the map, a row of chips shows what you did — a one-line summary is plenty. If a request needs a parcel but none is selected and you can't find one, say so briefly."""

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

# ── Macro registry (DIC-430) ──────────────────────────────────────────────────
# Declarative definition of the multi-step "workflows" that run_workflow expands.
# Adding a macro here is the ONLY change needed — the run_workflow tool's enum and
# description (below) and the _expand_workflow interpreter both read from this table.
#
# Each macro: {description, steps[], env_lookup}. A step is {type, payload} where
# `type` is a frontend command and `payload` is one of:
#   "pin"          → {"pin": pin} when a parcel is selected, else {} (current parcel)
#   "pin_required" → include the step only when a pin is set (payload {"pin": pin})
#   {...}          → a literal payload, used verbatim
# env_lookup: run the server-side environmental query at the parcel centroid and
# hand the result back to the model to summarize.
_PARAM_TYPES = ("number", "string", "boolean")     # macro param types
_COND_OPS = ("==", "!=", "in", "not_in", "truthy", "falsy")  # branching operators


def _interp(value, params):
    """Substitute $param tokens in a step payload. A value that is exactly "$name"
    becomes the raw (typed) param value; otherwise "$name" is string-substituted."""
    if isinstance(value, str):
        if value.startswith("$") and value[1:] in params:
            return params[value[1:]]
        out = value
        for k in sorted(params, key=len, reverse=True):  # longest names first
            out = out.replace("$" + k, str(params[k]))
        return out
    if isinstance(value, dict):
        return {k: _interp(v, params) for k, v in value.items()}
    if isinstance(value, list):
        return [_interp(v, params) for v in value]
    return value


def _cond_passes(when, env):
    """Evaluate a step's 'when' condition against the environmental result. Tiny,
    safe operator set — no code eval. Unknown/absent env → condition fails."""
    if not when:
        return True
    op = when.get("op")
    # Resolve a dotted field path (e.g. "flood.in_special_flood_hazard_area") into env.
    cur = env
    for part in when["field"].split("."):
        cur = cur.get(part) if isinstance(cur, dict) else None
    val = when.get("value")
    if op == "==":
        return cur == val
    if op == "!=":
        return cur != val
    if op == "in":
        return cur in (val or [])
    if op == "not_in":
        return cur not in (val or [])
    if op == "truthy":
        return bool(cur)
    if op == "falsy":
        return not bool(cur)
    return False


WORKFLOWS = {
    "analyze_parcel": {
        "description": "select + zoom, flood/wetlands layers, measure, and environmental data",
        "steps": [
            {"type": "select_parcel", "payload": "pin_required"},
            {"type": "fly_to_parcel", "payload": "pin"},
            {"type": "set_layer_visibility", "payload": {"layer_id": "flood", "visible": True}},
            {"type": "set_layer_visibility", "payload": {"layer_id": "wetlands", "visible": True}},
            {"type": "measure_parcel", "payload": "pin"},
        ],
        "env_lookup": True,
    },
    "check_buildability": {
        "description": "dimensions + a configurable setback ring (default 30 ft); also turns on the flood overlay if the parcel is in a flood hazard area",
        "params": {
            "setback_ft": {"type": "number", "default": 30,
                           "description": "Setback distance in feet for the buildable-area ring (default 30)."},
        },
        "steps": [
            {"type": "select_parcel", "payload": "pin_required"},
            {"type": "fly_to_parcel", "payload": "pin"},
            {"type": "dimension_parcel", "payload": "pin"},
            {"type": "draw_parcel_buffer", "payload": {"distance_ft": "$setback_ft", "inward": True, "label": "$setback_ft ft setback"}},
            # Branching: only add the flood overlay when the parcel is actually in a
            # special flood hazard area (evaluated server-side against the env lookup).
            {"type": "set_layer_visibility", "payload": {"layer_id": "flood", "visible": True},
             "when": {"field": "flood.in_special_flood_hazard_area", "op": "==", "value": "T"}},
        ],
        "env_lookup": True,
    },
    "risk_overview": {
        "description": "flood/wetlands/soils layers + environmental data",
        "steps": [
            {"type": "select_parcel", "payload": "pin_required"},
            {"type": "fly_to_parcel", "payload": "pin"},
            {"type": "set_layer_visibility", "payload": {"layer_id": "flood", "visible": True}},
            {"type": "set_layer_visibility", "payload": {"layer_id": "wetlands", "visible": True}},
            {"type": "set_layer_visibility", "payload": {"layer_id": "soils", "visible": True}},
        ],
        "env_lookup": True,
    },
}


def _validate_workflows(table):
    """Fail loudly at import if a macro is malformed, rather than silently skipping."""
    for name, wf in table.items():
        if not isinstance(wf.get("description"), str) or not wf["description"]:
            raise ValueError("Macro %r must have a non-empty 'description'." % name)
        params = wf.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError("Macro %r 'params' must be a dict." % name)
        for pname, pdef in params.items():
            if not isinstance(pdef, dict) or pdef.get("type") not in _PARAM_TYPES:
                raise ValueError("Macro %r param %r needs a 'type' of %s." % (name, pname, "/".join(_PARAM_TYPES)))
        steps = wf.get("steps")
        if not isinstance(steps, list) or not steps:
            raise ValueError("Macro %r must have a non-empty 'steps' list." % name)
        for i, step in enumerate(steps):
            if not isinstance(step.get("type"), str) or not step["type"]:
                raise ValueError("Macro %r step %d is missing a string 'type'." % (name, i))
            spec = step.get("payload")
            if not (spec in ("pin", "pin_required") or isinstance(spec, dict)):
                raise ValueError(
                    "Macro %r step %d (%r) has an invalid payload %r — expected "
                    "'pin', 'pin_required', or a literal dict." % (name, i, step["type"], spec)
                )
            when = step.get("when")
            if when is not None:
                if not isinstance(when, dict) or not isinstance(when.get("field"), str):
                    raise ValueError("Macro %r step %d 'when' needs a string 'field'." % (name, i))
                if when.get("op") not in _COND_OPS:
                    raise ValueError("Macro %r step %d 'when' has an invalid 'op' %r." % (name, i, when.get("op")))
    return table


_validate_workflows(WORKFLOWS)

# Tool description is generated from the registry so a new macro needs no edits here.
_WF_DESC = (
    "Run a common multi-step workflow in ONE call instead of chaining tools "
    "yourself — faster, cheaper, deterministic. "
    + " ".join("'%s' = %s." % (k, v["description"]) for k, v in WORKFLOWS.items())
    + " The environmental results come back to you — summarize them for the user."
)


def _wf_params_schema():
    """Union of every macro's params, exposed as optional run_workflow properties
    so the model can fill a slot (e.g. setback_ft) from natural language."""
    props = {}
    for wf in WORKFLOWS.values():
        for pname, pdef in (wf.get("params") or {}).items():
            props[pname] = {"type": pdef["type"], "description": pdef.get("description", "")}
    return props


TOOLS = [
    # ── Camera ────────────────────────────────────────────────────────────────
    {"name": "fly_to_parcel", "description": "Quickly zoom and pan the map to frame a parcel (no flourish). Defaults to the selected parcel. For 'show me / fly to', prefer cinematic_fly_to_parcel.",
     "input_schema": {"type": "object", "properties": {"pin": _PIN}, "required": []}},
    {"name": "cinematic_fly_to_parcel", "description": "Cinematic fly-to a parcel: tilt into 3-D, fly in, orbit a full 360° around it, then settle back to a flat north-up view. Use this whenever the user wants to SEE or be shown a parcel — 'fly to / show me / take me to / give me a look at / tour this parcel'.",
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
    {"name": "pulse_layer", "description": "Gently pulse an overlay to draw the eye to it WHILE you talk about it — call this whenever your reply references a layer ('this parcel is in the floodplain', 'the wetlands to the north'). It turns the layer on if needed and blooms it briefly. Prefer this over set_layer_visibility when the point is to direct attention to a layer you're discussing. The pulse self-gates on the user's Map-reactions setting, so always call it; it quietly no-ops when reactions are off.",
     "input_schema": {"type": "object", "properties": {
         "layer_id": {"type": "string", "description": "Layer to pulse: a federal overlay (flood, wetlands, soils, hillshade, contours) or a county PostGIS layer id"}},
      "required": ["layer_id"]}},

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
    {"name": "get_environmental_info", "description": "Look up REAL environmental constraints at a point (use the selected parcel's centroid): FEMA flood zone, USFWS wetlands, and USDA soil type. Use this to ANSWER 'is this in a floodplain / are there wetlands / what's the soil / is it buildable' — don't guess. Optionally also turn on the matching overlay so the user sees it.",
     "input_schema": {"type": "object", "properties": {"lng": _LNG, "lat": _LAT}, "required": ["lng", "lat"]}},

    # ── Interface / appearance ────────────────────────────────────────────────
    {"name": "set_theme", "description": "Switch the viewer between dark and light mode.",
     "input_schema": {"type": "object", "properties": {"mode": {"type": "string", "enum": ["dark", "light"]}}, "required": ["mode"]}},
    {"name": "set_basemap", "description": "Set the basemap: 'light' or 'dark' street map, or 'aerial' satellite imagery (aerial also dims the parcel fills).",
     "input_schema": {"type": "object", "properties": {"basemap": {"type": "string", "enum": ["light", "dark", "aerial"]}}, "required": ["basemap"]}},
    {"name": "set_base_layer", "description": "Toggle the aerial-imagery layer and/or the parcels layer on or off independently.",
     "input_schema": {"type": "object", "properties": {"aerial": {"type": "boolean"}, "parcels": {"type": "boolean"}}, "required": []}},
    {"name": "set_accessibility", "description": "Adjust accessibility settings: large_text, high_contrast, readable_font (Atkinson Hyperlegible), reduce_motion, reduce_transparency (solid panels). Or max=true for maximum accessibility, max=false to reset.",
     "input_schema": {"type": "object", "properties": {
         "max": {"type": "boolean"}, "large_text": {"type": "boolean"}, "high_contrast": {"type": "boolean"},
         "readable_font": {"type": "boolean"}, "reduce_motion": {"type": "boolean"}, "reduce_transparency": {"type": "boolean"}}, "required": []}},
    {"name": "set_panel_transparency", "description": "Set how see-through the glass panels are. alpha 0.4 = very transparent, 1.0 = solid.",
     "input_schema": {"type": "object", "properties": {"alpha": {"type": "number"}}, "required": ["alpha"]}},
    {"name": "open_panel", "description": "Open the map control panel to a tab (layers, select, draw, measure).",
     "input_schema": {"type": "object", "properties": {"panel": {"type": "string"}, "tab": {"type": "string", "enum": ["layers", "select", "draw", "measure"]}}, "required": []}},
    {"name": "set_area_units", "description": "Set area units to acres or square feet.",
     "input_schema": {"type": "object", "properties": {"units": {"type": "string", "enum": ["acres", "sqft"]}}, "required": ["units"]}},
    {"name": "set_coordinate_format", "description": "Set the cursor coordinate readout format: dd (decimal degrees), dms, or spc (State Plane).",
     "input_schema": {"type": "object", "properties": {"format": {"type": "string", "enum": ["dd", "dms", "spc"]}}, "required": ["format"]}},
    {"name": "bookmark_current", "description": "Bookmark the currently selected parcel (saved on this device).",
     "input_schema": {"type": "object", "properties": {}, "required": []}},

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

    # ── Workflows (one deterministic call instead of chaining tools) ──────────
    {"name": "run_workflow", "description": _WF_DESC,
     "input_schema": {"type": "object",
                      "properties": dict({"workflow": {"type": "string", "enum": list(WORKFLOWS.keys())}, "pin": _PIN}, **_wf_params_schema()),
                      "required": ["workflow"]}},

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

        # Live layer state (DIC-327): what's on the map right now + each layer's
        # field schema, so answers reflect the actual view. Falls back to the
        # legacy visible-overlay labels when the registry isn't present.
        layers = map_state.get("layers")
        if layers:
            def _fmt(layer: dict) -> str:
                fields = layer.get("fields") or []
                schema = f" — fields: {', '.join(fields)}" if fields else ""
                return f"    - {layer.get('label')} ({layer.get('type')}){schema}"

            on = [l for l in layers if l.get("visible")]
            off = [l for l in layers if not l.get("visible")]
            ms_lines.append("  Layers currently ON (visible to the user):")
            ms_lines.extend([_fmt(l) for l in on] or ["    (none)"])
            if off:
                ms_lines.append(
                    "  Layers available but currently OFF: "
                    + ", ".join(l.get("label") for l in off)
                )
        else:
            vis = map_state.get("visible_layers") or []
            ms_lines.append(f"  Visible overlays: {', '.join(vis) if vis else 'none'}")
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
DATA_TOOLS = {"search_parcels", "get_parcel_info", "get_environmental_info"}

# Public federal services — queried directly server-side (no CORS proxy needed)
# to ANSWER environmental questions, mirroring frontend/public/js/wms-feature-info.js.
_FEMA_NFHL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
_NWI_WETLANDS = "https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query"
_SSURGO_WMS = "https://sdmdataaccess.nrcs.usda.gov/Spatial/SDM.wms"


def _arcgis_point_query(base: str, lng: float, lat: float):
    qs = urllib.parse.urlencode({
        "geometry": f"{lng},{lat}", "geometryType": "esriGeometryPoint",
        "inSR": "4326", "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*", "returnGeometry": "false", "f": "json",
    })
    with urllib.request.urlopen(base + "?" + qs, timeout=12) as r:
        data = json.loads(r.read().decode())
    feats = data.get("features") or []
    if not feats:
        return None
    attrs = feats[0].get("attributes", {})
    return {k.split(".")[-1]: v for k, v in attrs.items()}  # strip "Table." prefixes


def _query_soils(lng: float, lat: float):
    R = 6378137.0
    mx = lng * math.pi * R / 180.0
    my = math.log(math.tan(math.pi / 4 + lat * math.pi / 360.0)) * R
    half = 150.0  # ~150 m box, query the centre pixel
    qs = urllib.parse.urlencode({
        "SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetFeatureInfo",
        "LAYERS": "MapunitPolyExtended", "QUERY_LAYERS": "MapunitPolyExtended",
        "BBOX": f"{mx-half},{my-half},{mx+half},{my+half}",
        "WIDTH": "256", "HEIGHT": "256", "X": "128", "Y": "128",
        "SRS": "EPSG:3857", "INFO_FORMAT": "text/plain", "FEATURE_COUNT": "3",
    })
    with urllib.request.urlopen(_SSURGO_WMS + "?" + qs, timeout=12) as r:
        text = r.read().decode("utf-8", "replace")
    props = {}
    for line in text.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            k = k.strip().lower(); v = v.strip().strip("'\"")
            if k in ("muname", "musym") and v and k not in props:
                props[k] = v
    return {"name": props.get("muname"), "symbol": props.get("musym")} if props else None


def _query_environment(lng: float, lat: float) -> dict:
    out = {}
    try:
        a = _arcgis_point_query(_FEMA_NFHL, lng, lat)
        out["flood"] = ({"zone": a.get("FLD_ZONE"), "subtype": a.get("ZONE_SUBTY"),
                         "in_special_flood_hazard_area": a.get("SFHA_TF"), "base_flood_elev_ft": a.get("STATIC_BFE")}
                        if a else {"zone": "X", "note": "no FEMA flood hazard mapped at this point"})
    except Exception as e:
        out["flood"] = {"error": str(e)}
    try:
        a = _arcgis_point_query(_NWI_WETLANDS, lng, lat)
        out["wetlands"] = ({"present": True, "type": a.get("WETLAND_TYPE"), "acres": a.get("ACRES")}
                           if a else {"present": False})
    except Exception as e:
        out["wetlands"] = {"error": str(e)}
    try:
        out["soil"] = _query_soils(lng, lat) or {"note": "no soil map unit returned"}
    except Exception as e:
        out["soil"] = {"error": str(e)}
    return out


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
        if name == "get_environmental_info":
            lng, lat = inp.get("lng"), inp.get("lat")
            if lng is None or lat is None:
                return "Provide the point as lng + lat (use the selected parcel's centroid)."
            return json.dumps(_query_environment(float(lng), float(lat)))
    except Exception as e:
        return f"Lookup failed: {e}"
    return "Unknown data tool."


# Deterministic macros: a single run_workflow call expands a WORKFLOWS entry into
# a fixed sequence of frontend commands (+ a server-side environmental lookup), so
# the model spends one tool call instead of re-deciding the same chain every time.
# The macro definitions live in WORKFLOWS (above); this just interprets them.
def _expand_workflow(name: str, inp: dict, ctx: dict | None):
    wf = WORKFLOWS.get(name)
    if not wf:
        return ("Unknown workflow '%s'." % name, [])

    # Resolve + validate params (model-supplied slot values, else the default).
    params = {}
    for pname, pdef in (wf.get("params") or {}).items():
        val = inp.get(pname)
        if val is None:
            val = pdef.get("default")
        elif pdef["type"] == "number" and not isinstance(val, (int, float)):
            return ("Can't run '%s': %r must be a number." % (name, pname), [])
        elif pdef["type"] == "string" and not isinstance(val, str):
            return ("Can't run '%s': %r must be text." % (name, pname), [])
        elif pdef["type"] == "boolean" and not isinstance(val, bool):
            return ("Can't run '%s': %r must be true or false." % (name, pname), [])
        params[pname] = val

    # Environmental lookup first — needed for branching (`when`) and the summary.
    env = None
    if wf.get("env_lookup") or any("when" in s for s in wf["steps"]):
        centroid = (ctx or {}).get("centroid")
        if centroid and len(centroid) >= 2:
            try:
                env = _query_environment(float(centroid[0]), float(centroid[1]))
            except Exception as e:
                env = {"error": str(e)}

    pin = inp.get("pin")
    cmds = []
    for step in wf["steps"]:
        if "when" in step and not _cond_passes(step["when"], env):
            continue
        spec = step.get("payload")
        if spec == "pin_required":
            if not pin:
                continue
            payload = {"pin": pin}
        elif spec == "pin":
            payload = {"pin": pin} if pin else {}
        elif isinstance(spec, dict):
            payload = _interp(dict(spec), params)
        else:
            payload = {}
        cmds.append({"type": step["type"], "payload": payload})

    note = "Ran workflow '%s' (%d map actions)." % (name, len(cmds))
    if env is not None:
        note += " Environmental data: " + json.dumps(env)
    note += " Now give the user a short, clean summary."
    return (note, cmds)


def _tool_ack(name: str) -> str:
    if name in ("measure_parcel", "measure_area", "measure_distance"):
        return "Measurement computed and shown to the user."
    if name == "search_parcels":
        return "Search ran; results are shown to the user, and a single match is auto-selected and centered."
    if name == "suggest_actions":
        return "Suggestions shown to the user."
    if name == "pulse_layer":
        return "Layer pulsed (or quietly skipped if the user has map reactions off)."
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
                    if block.name == "run_workflow":
                        # Deterministic macro: expand into a fixed command chain
                        # (+ server-side env data) so the model spends one call.
                        result, wf_cmds = _expand_workflow(inp.get("workflow"), inp, ctx)
                        commands.extend(wf_cmds)
                    elif block.name in DATA_TOOLS:
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


# ── Explainer engine (DIC-370) ────────────────────────────────────────────────
# A separate, narrowly-scoped "teacher" model that explains a parcel's assessment
# in plain language. It follows the two-engine / citation-first discipline: the
# caller assembles the *verified figures* (the deterministic "truth"), and this
# model only narrates them — it never originates a dollar amount, a millage rate,
# or a statute it wasn't given. Michigan law is supplied below as a curated
# reference so citations come from a vetted list, not the model's memory.

EXPLAIN_MODEL = os.getenv("EXPLAIN_MODEL", os.getenv("MAP_BUDDY_MODEL", "claude-sonnet-4-6"))

# Curated Michigan property-tax statute reference. The model must cite ONLY from
# this list (or name no citation) — keeps legal references accurate for a
# county-facing tool. Update here when the law changes.
_MI_TAX_STATUTES = """\
- General Property Tax Act — 1893 PA 206 (MCL 211.1 et seq.): the framework for assessing and taxing real property in Michigan.
- Assessment at 50% of True Cash Value — Mich. Const. Art. IX, Sec. 3 and MCL 211.27a: Assessed Value (AV) is half of a property's True Cash (market) Value.
- State Equalized Value (SEV) & equalization — MCL 211.34: county and state equalization confirm assessments sit uniformly at the 50% level; SEV is AV after equalization.
- Taxable Value cap (Proposal A) — MCL 211.27a(2): a property's Taxable Value (TV) rises each year by the lesser of 5% or the inflation rate multiplier (CPI), until ownership transfers.
- Uncapping on transfer of ownership — MCL 211.27a(3); "transfer of ownership" defined at MCL 211.27a(6)–(7): the year after a transfer, TV resets ("uncaps") to that year's SEV.
- Principal Residence Exemption (PRE) — MCL 211.7cc and 211.7dd: exempts an owner-occupied principal residence from up to 18 mills of local school operating tax.
- Property classification — MCL 211.34c: the assessor assigns each parcel an STC class (agricultural, commercial, industrial, residential, timber-cutover, developmental).
- March Board of Review — MCL 211.30: the first level of appeal for assessment, taxable value, or classification disputes.
- Michigan Tax Tribunal — MCL 205.731: appeals beyond the Board of Review; residential/agricultural appeals follow the Board of Review, commercial/industrial may go directly by May 31.
"""

_ASSESSMENT_SYSTEM = """You are the Assessment Explainer for the Van Buren County, Michigan parcel viewer — a focused educational assistant that explains a single parcel's property assessment in plain, friendly language for a general audience.

# The one rule that matters: explain, never originate
You are the "teacher", not the "calculator". You will be given a block of VERIFIED FIGURES for one parcel (assessed value, taxable value, history, PRE, classification, etc.) that were pulled directly from the assessment database. Your job is to explain what those numbers mean and how Michigan's system produced them.

- NEVER state a dollar amount, percentage, millage rate, year, or classification that is not in the VERIFIED FIGURES. If a figure isn't provided (e.g. a specific millage rate or SEV), explain the concept generally and say the exact figure isn't shown here — do not invent one.
- NEVER compute new figures beyond what is given. You may restate and compare the provided numbers (e.g. "your taxable value is lower than your assessed value, which is common under the cap"), but do not derive new dollar values.
- This is educational information, not tax advice or an official assessment notice.

# Tie every explanation to THIS parcel's numbers
Do not explain concepts in the abstract when a figure is available — anchor each one to this parcel:
- The summary and sections must reference this parcel's actual figures by value (e.g. "your Taxable Value of $98,000…", "your assessment classification is 401 – Residential…").
- In the GLOSSARY, every term that has a matching figure for this parcel must state that figure in its definition. Define "Taxable Value" by naming this parcel's TV; define "PRE" by naming this parcel's exemption percentage; etc. Only fall back to a generic definition when this parcel has no corresponding value.
- When you reference the assessment year, use the years given in the figures (the history is labeled by year).

# Citing Michigan law
Cite statutes ONLY from the "Michigan property-tax statutes" reference block provided to you below. If a point isn't covered there, explain it without a citation rather than guessing one.

# What to cover
- What the numbers mean: Assessed Value (AV, 50%% of True Cash Value), State Equalized Value (SEV), Taxable Value (TV), True Cash / market value, and the Principal Residence Exemption (PRE).
- The single most common point of confusion: assessing vs. equalization vs. appraisal — distinguish them clearly.
- Proposal A: why TV is usually below AV, the annual cap, and what "uncapping" on sale means.
- Where property taxes generally go (schools, county, township, libraries, roads, special assessments) — describe the categories; do NOT invent specific millage numbers for this parcel.
- The owner's appeal rights (March Board of Review, then the Michigan Tax Tribunal). Where contact information is provided to you below, point the owner to it.

# Style
Warm, clear, and concise — short paragraphs, no jargon without a plain-language gloss. No emojis. Write for a homeowner, not an assessor. Always note the assessment year/vintage if given, and that the assessor or Board of Review is the authority for official figures and appeals."""


# ── Explainer profiles (config-driven; future home: writable store + admin UI) ─
# Each explainer is a profile: a base system prompt plus an ordered list of
# *context blocks* (reference material injected as grounding). Keeping prompt +
# context as data — not hardcoded into run_explain — is what lets an admin console
# later edit the prompt and add references (assessor's manual, township contacts,
# STC bulletins) per explainer without a code change. The assembled static
# system text is marked cache-eligible, so even a large injected manual costs
# little per request (only the per-parcel facts vary). See DIC-400 for the
# writable-store + admin surface this dict will migrate into.
# Curated survey / legal-description terminology. The model defines terms from
# this vetted list rather than its memory — the same citation-first discipline
# applied to terminology (DIC-369 Phase 1).
_TAX_DESC_TERMS = """\
Metes-and-bounds (a traverse of bearings & distances):
- COM / COMM — "commencing at"; the starting reference point of the description.
- BEG / POB — "beginning" / Point of Beginning; where the described boundary actually starts (often reached after a tie line from the COM point).
- TH / THENCE — "thence"; introduces the next course (direction + distance).
- Bearings like "N 89° E" or "S 12°30' W" — a direction stated as an angle east or west of due north or south (quadrant bearing).
- DEG / MIN / SEC (° ' ") — degrees, minutes, seconds of a bearing angle.
- FT (feet), CH (chains, 66 ft), RD (rods, 16.5 ft), LK (links, 0.66 ft) — distance units.

Public Land Survey System (PLSS) / aliquot parts:
- T / TWP and R / RGE — Town(ship) and Range; the grid coordinates of a 6-mile-square township (e.g. "T1S R13W").
- SEC — Section; a 1-mile-square (≈640-acre) block, 36 per township.
- Aliquot fractions like "NW 1/4 of SE 1/4" — nested quarter divisions of a section ("the northwest quarter of the southeast quarter").
- N 1/2, S 1/2, E 1/2, W 1/2 — half-section or half-quarter divisions.

Platted / subdivision descriptions:
- LOT and BLK (block) — a numbered lot within a recorded subdivision plat.
- ADD / SUB / "ASSESSOR'S PLAT" — the name of the recorded subdivision the lot belongs to.

General:
- EXC / EX — "except(ing)"; land carved out of the described parcel.
- SD — "said"; refers back to a feature already named.
"""

_TAX_DESCRIPTION_SYSTEM = """You are the Tax Description Explainer for the Van Buren County, Michigan parcel viewer — a focused educational assistant that explains a single parcel's TAX DESCRIPTION in plain, friendly language for a general audience.

# What a tax description is (lead with this)
A tax description is an ABBREVIATED, shorthand version of a property's deeded legal description, kept on the assessment roll to IDENTIFY the parcel for taxation. It is NOT a boundary survey and NOT the controlling legal document. Explain clearly WHY this matters:
- It may omit detail and uses heavy abbreviation, so it can be ambiguous on its own.
- It must never be used on deeds, titles, mortgages, or to settle a boundary — the recorded deed (and a licensed survey) are authoritative.
This tax-vs-legal distinction is the single most important thing for a reader to understand.

# The one rule that matters: explain the text, never compute geometry
You will be given the VERBATIM tax description text and a detected description TYPE. Your job is to explain the terminology and structure of THAT text.
- NEVER compute, close, or assert geometry: do not state the parcel's shape, area, or that the courses connect/close; do not infer a bearing or distance that isn't written in the text; do not "trace" the parcel.
- You MAY quote the literal text and explain what each written part means (e.g. "the description reads 'TH N 89° E 200 FT', which is a course heading roughly east for 200 feet").
- If the reader wants the parcel drawn on the map call-by-call, say that leg-by-leg mapping is a planned future feature — you can explain the words today.
- Define terms ONLY from the terminology reference provided to you below; if a token isn't covered there, say it appears to be an abbreviation and suggest confirming it with the assessor rather than guessing.

# Use the detected type to frame the explanation
- "metes_bounds" — a traverse of bearings and distances from a starting point. Walk through the COM/BEG/THENCE structure conceptually.
- "aliquot_plss" — a Public Land Survey System description (township/range/section + quarter divisions). Explain the nested-quarter and section grid.
- "platted_lot" — a lot/block within a recorded subdivision plat. Explain lots, blocks, and the plat.
- "mixed" / "unknown" — explain the parts you can identify and note the rest plainly.

# Output
- summary: 1-2 plain sentences on what this description is identifying, WITHOUT asserting geometry.
- sections: the tax-vs-legal distinction (and why it matters); a structural walk-through of THIS description's parts; and a short "what this is / isn't" note.
- glossary: define the terms that actually appear in this description (from the reference list), in one sentence each.
- statutes: leave this an empty list unless a statute in your reference is directly relevant — this explainer is about terminology, not tax law.
- disclaimer: educational only; not a survey or legal description; never use on deeds/titles; refer to the recorded deed and the assessor.

# Style
Warm, clear, concise. Short paragraphs, no jargon without a plain-language gloss. No emojis. Write for a property owner, not a surveyor."""


EXPLAINER_PROFILES = {
    "assessment": {
        "label": "Assessment Explainer",
        "audience": "Local residents / property owners (plain language)",
        "model": EXPLAIN_MODEL,
        "system_prompt": _ASSESSMENT_SYSTEM,
        "context_blocks": [
            {
                "title": "Michigan property-tax statutes (cite ONLY from this list)",
                "body": _MI_TAX_STATUTES,
            },
            # Add here (or, later, via the admin console): township/assessor contact
            # directory, State Tax Commission Assessor's Manual excerpts, local
            # special-assessment notes, current-year inflation rate multiplier, etc.
        ],
    },
    "tax_description": {
        "label": "Tax Description Explainer",
        "audience": "Local residents / property owners (plain language)",
        "model": EXPLAIN_MODEL,
        "system_prompt": _TAX_DESCRIPTION_SYSTEM,
        "context_blocks": [
            {
                "title": "Survey / legal-description terminology (define ONLY from this list)",
                "body": _TAX_DESC_TERMS,
            },
            # Later, via the admin console: county-specific abbreviation conventions,
            # local plat/subdivision index, controlling-corner notes, etc.
        ],
    },
}


def explainer_profiles_public() -> list:
    """Serializable view of the explainer plugins for the admin console (DIC-459).
    Exposes prompt + injected context (no secrets — there are none here). Each
    explainer is callable as a plugin via POST /explain with its topic id."""
    out = []
    for topic, p in EXPLAINER_PROFILES.items():
        out.append({
            "id": topic,
            "label": p.get("label", topic),
            "audience": p.get("audience"),
            "model": p.get("model"),
            "callable_via": f"POST /explain (topic: {topic})",
            "system_prompt": p.get("system_prompt", ""),
            "context_blocks": [
                {"title": b.get("title", ""), "body": b.get("body", ""), "chars": len(b.get("body", ""))}
                for b in p.get("context_blocks", [])
            ],
        })
    return out


def _assemble_system(profile: dict) -> str:
    """Concatenate a profile's base prompt with its injected reference blocks."""
    parts = [profile["system_prompt"]]
    for blk in profile.get("context_blocks", []):
        body = (blk.get("body") or "").strip()
        if body:
            parts.append("\n\n# Reference: " + blk.get("title", "") + "\n" + body)
    return "".join(parts)


# Structured output contract for the explainer. Forcing this tool guarantees a
# stable shape the frontend can lay out via PV_TEMPLATE.
_EXPLAIN_TOOL = {
    "name": "render_explanation",
    "description": "Return the structured assessment explanation for this parcel.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {
                "type": "string",
                "description": "1-2 sentence plain-language read of THIS parcel's numbers, grounded only in the verified figures.",
            },
            "sections": {
                "type": "array",
                "description": "Ordered explanatory sections.",
                "items": {
                    "type": "object",
                    "properties": {
                        "heading": {"type": "string"},
                        "body": {"type": "string", "description": "A few short paragraphs of plain text. No markdown tables."},
                    },
                    "required": ["heading", "body"],
                },
            },
            "glossary": {
                "type": "array",
                "description": "Key terms (AV, SEV, TV, TCV, PRE, millage, etc.), each defined in one sentence. Where this parcel has a matching figure, the definition MUST state that figure (e.g. 'Taxable Value (TV) — the $98,000 your taxes are levied on').",
                "items": {
                    "type": "object",
                    "properties": {
                        "term": {"type": "string"},
                        "definition": {"type": "string"},
                    },
                    "required": ["term", "definition"],
                },
            },
            "statutes": {
                "type": "array",
                "description": "Relevant Michigan statutes cited, drawn ONLY from the provided reference list.",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "e.g. 'Taxable Value cap (Proposal A)'"},
                        "citation": {"type": "string", "description": "e.g. 'MCL 211.27a(2)'"},
                        "plain": {"type": "string", "description": "One-sentence plain-language summary."},
                    },
                    "required": ["name", "citation", "plain"],
                },
            },
            "disclaimer": {
                "type": "string",
                "description": "One or two sentences: educational only, not tax advice/official notice; direct to assessor / Board of Review.",
            },
        },
        "required": ["summary", "sections", "glossary", "statutes", "disclaimer"],
    },
}


def run_explain(topic: str, facts: dict) -> dict:
    """Generate a structured, grounded explanation for a parcel.

    `facts` is the deterministic "truth" assembled by the caller. Returns the
    validated tool input (summary/sections/glossary/statutes/disclaimer). Raises
    on a missing key or if the model declines to call the tool.
    """
    profile = EXPLAINER_PROFILES.get(topic)
    if not profile:
        raise ValueError(f"unsupported explainer topic: {topic!r}")

    # Static, reusable across every parcel → cache it. Only the per-parcel facts
    # (the user turn) vary, so a large injected reference corpus stays cheap.
    system = [{
        "type": "text",
        "text": _assemble_system(profile),
        "cache_control": {"type": "ephemeral"},
    }]
    user = (
        "Explain this parcel using ONLY the authoritative input below. Anything "
        "not present here must be described generally, never invented.\n\n"
        "INPUT DATA:\n"
        + json.dumps(facts, indent=2, default=str)
    )

    max_tokens = int(os.getenv("EXPLAIN_MAX_TOKENS", "2048"))
    response = _get_client().messages.create(
        model=profile["model"],
        max_tokens=max_tokens,
        system=system,
        tools=[_EXPLAIN_TOOL],
        tool_choice={"type": "tool", "name": "render_explanation"},
        messages=[{"role": "user", "content": user}],
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == "render_explanation":
            return dict(block.input or {})
    raise RuntimeError("model did not return a render_explanation tool call")


_AUTOCONFIGURE_TOOL = {
    "name": "propose_theme_refinement",
    "description": (
        "Return a plain-language rationale for the draft theme and concrete suggested "
        "tweaks the operator can apply. You NEVER change the manifest yourself."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "rationale": {"type": "string", "description": "2-4 sentences: why this theme fits the brief, for a county GIS operator."},
            "suggestions": {
                "type": "array",
                "description": "Optional concrete tweaks the operator might apply in the editor.",
                "items": {
                    "type": "object",
                    "properties": {
                        "field": {"type": "string", "description": "manifest path, e.g. capabilities.cogo or persona.audience"},
                        "change": {"type": "string", "description": "the suggested change"},
                        "why": {"type": "string", "description": "why it would help"},
                    },
                    "required": ["field", "change"],
                },
            },
        },
        "required": ["rationale"],
    },
}


def run_autoconfigure(brief: dict, draft: dict, rationale: str = "") -> dict:
    """AI refinement for the Theme Composer (B3 / DIC-579). Narrates over the
    DETERMINISTIC draft manifest — explains the choices and suggests optional tweaks — but
    never originates the manifest (facts-parity §4.6). Forced structured tool call; returns
    the validated { rationale, suggestions } the frontend lays over the draft for review.
    """
    system = [{
        "type": "text",
        "text": (
            "You help a county GIS operator review an AUTO-GENERATED draft theme manifest "
            "for the Intelligent Spatial Viewer. The draft was assembled deterministically "
            "from the operator's brief. Your job: (1) explain in plain language why the draft "
            "fits the brief, and (2) suggest optional concrete tweaks. You DO NOT and CANNOT "
            "change the manifest — the operator applies any changes in the editor. Ground "
            "every statement in the provided draft + brief; never invent capabilities or "
            "sources that aren't present."
        ),
        "cache_control": {"type": "ephemeral"},
    }]
    user = (
        "BRIEF:\n" + json.dumps(brief, indent=2, default=str) +
        "\n\nDETERMINISTIC DRAFT MANIFEST:\n" + json.dumps(draft, indent=2, default=str) +
        (("\n\nBASELINE RATIONALE:\n" + rationale) if rationale else "")
    )
    model = os.getenv("AUTOCONFIGURE_MODEL", "claude-haiku-4-5")
    max_tokens = int(os.getenv("AUTOCONFIGURE_MAX_TOKENS", "1024"))
    response = _get_client().messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        tools=[_AUTOCONFIGURE_TOOL],
        tool_choice={"type": "tool", "name": "propose_theme_refinement"},
        messages=[{"role": "user", "content": user}],
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == "propose_theme_refinement":
            return dict(block.input or {})
    raise RuntimeError("model did not return a propose_theme_refinement tool call")


_JUDGE_TOOL = {
    "name": "report_grounding_verdict",
    "description": (
        "Report whether the AI OUTPUT is grounded in the GROUNDING TRUTH and whether every "
        "claim that needs a source is supported. Be strict: an unsupported figure or an "
        "invented citation is a failure."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "grounded": {"type": "boolean", "description": "true iff every factual claim traces to the grounding truth (no invented figures/claims)."},
            "citations_ok": {"type": "boolean", "description": "true iff every cited source appears in the grounding truth and supports the claim."},
            "issues": {"type": "array", "items": {"type": "string"}, "description": "Specific problems found (empty if none)."},
        },
        "required": ["grounded", "citations_ok", "issues"],
    },
}


def run_grounding_judge(output_text: str, grounding: dict) -> dict:
    """LLM-judge gate (C5 / DIC-586). Scores whether an AI output is grounded in the
    deterministic truth + whether its citations are accurate — the non-deterministic
    complement to the deterministic ai-quality checks. Intended as a gate run before a
    prompt/model change ships, NOT per request. Forced structured tool call; returns
    { grounded, citations_ok, issues }.
    """
    system = [{
        "type": "text",
        "text": (
            "You are a strict grounding auditor for a government GIS assistant. You are given "
            "an AI OUTPUT and the GROUNDING TRUTH it was supposed to rely on. Decide whether "
            "every factual claim in the output traces to the truth (no invented numbers, "
            "names, or laws) and whether any cited source actually appears in and supports "
            "the claim. When in doubt, fail it — freelancing is worse than abstaining."
        ),
        "cache_control": {"type": "ephemeral"},
    }]
    user = (
        "GROUNDING TRUTH:\n" + json.dumps(grounding, indent=2, default=str) +
        "\n\nAI OUTPUT:\n" + str(output_text)
    )
    model = os.getenv("JUDGE_MODEL", "claude-haiku-4-5")
    response = _get_client().messages.create(
        model=model,
        max_tokens=int(os.getenv("JUDGE_MAX_TOKENS", "1024")),
        system=system,
        tools=[_JUDGE_TOOL],
        tool_choice={"type": "tool", "name": "report_grounding_verdict"},
        messages=[{"role": "user", "content": user}],
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == "report_grounding_verdict":
            return dict(block.input or {})
    raise RuntimeError("model did not return a report_grounding_verdict tool call")
