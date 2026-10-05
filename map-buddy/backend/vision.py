"""vision.py — describe the current map view with a vision model (DIC-2135).

The browser captures the map canvas (aerial plus whatever overlays are on) and posts it
here; the model returns a short plain-language description that Map Buddy uses to answer
a visual question ("is there a barn on this parcel?"). Ported from ZIP's /analyze-map.

The description is an AI interpretation of imagery, not a record: the viewer labels it
"AI visual read" and never stores it as parcel data.

Images are checked before any model call: JPEG or PNG only, the bytes must match the
declared type, at most VISION_MAX_IMAGE_BYTES, and at most MAX_LONG_EDGE pixels on the
long edge (the vision models' high-resolution limit; the browser scales to fit).
"""

import base64
import binascii
import os
import struct

from agent import _create_message

# Sonnet 5.5 (DIC-2138): on the 21-view evaluation it matched Opus 5.5 (21/21) at less
# than half the cost (about $0.008 vs $0.02 a look) and faster (5.5 s vs 8.6 s).
VISION_MODEL = os.getenv("VISION_MODEL", "claude-sonnet-5-5")
# Unset → the model's default effort. A map description may hold up at "low"; set
# VISION_EFFORT to compare once the evaluation set exists.
VISION_EFFORT = os.getenv("VISION_EFFORT", "")
VISION_MAX_TOKENS = int(os.getenv("VISION_MAX_TOKENS", "4096"))
VISION_MAX_IMAGE_BYTES = int(os.getenv("VISION_MAX_IMAGE_BYTES", str(2_000_000)))
MAX_LONG_EDGE = 2576
# One Map Buddy deployment serves one county (like MAP_BUDDY_TENANT), so the place the
# prompt names is server config, not something the browser sends.
VISION_PLACE = os.getenv("MAP_BUDDY_PLACE", "Van Buren County, Michigan")

_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_JPEG_SIG = b"\xff\xd8\xff"
# JPEG start-of-frame markers carry the image size; C4 (DHT), C8 (JPG) and CC (DAC)
# share the range but aren't frames.
_SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


# What the caller is told for each rejection. The route sends these fixed strings, looked
# up by code, never text taken from the exception (CodeQL py/stack-trace-exposure).
IMAGE_ERRORS = {
    "base64": "The image isn't valid base64.",
    "empty": "The image is empty.",
    "too_large": "The image is too large.",
    "type": "Only JPEG or PNG images are accepted.",
    "unreadable": "The image couldn't be read.",
    "too_big_px": f"The image is larger than {MAX_LONG_EDGE} px on its long edge.",
}


class ImageRejected(ValueError):
    """The upload isn't an image we accept. `code` is a key of IMAGE_ERRORS."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def image_error_message(code: str) -> str:
    """The fixed message for a rejection code."""
    return IMAGE_ERRORS.get(code, IMAGE_ERRORS["unreadable"])


class VisionRefused(RuntimeError):
    """The model declined to describe the image (stop_reason "refusal")."""


def _png_size(data: bytes) -> tuple[int, int]:
    if len(data) < 24 or data[12:16] != b"IHDR":
        raise ImageRejected("unreadable")
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def _jpeg_size(data: bytes) -> tuple[int, int]:
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            raise ImageRejected("unreadable")
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:  # no length field
            i += 2
            continue
        (length,) = struct.unpack(">H", data[i + 2 : i + 4])
        if marker in _SOF_MARKERS:
            if i + 9 > len(data):
                break
            height, width = struct.unpack(">HH", data[i + 5 : i + 9])
            return width, height
        i += 2 + length
    raise ImageRejected("unreadable")


def check_image(image_b64: str, media_type: str) -> tuple[bytes, int, int]:
    """Decode and validate an upload. Returns (bytes, width, height); raises ImageRejected."""
    try:
        data = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError):
        raise ImageRejected("base64") from None
    if not data:
        raise ImageRejected("empty")
    if len(data) > VISION_MAX_IMAGE_BYTES:
        raise ImageRejected("too_large")
    if media_type == "image/png" and data.startswith(_PNG_SIG):
        width, height = _png_size(data)
    elif media_type == "image/jpeg" and data.startswith(_JPEG_SIG):
        width, height = _jpeg_size(data)
    else:
        raise ImageRejected("type")
    if not width or not height:
        raise ImageRejected("unreadable")
    if max(width, height) > MAX_LONG_EDGE:
        raise ImageRejected("too_big_px")
    return data, width, height


VISION_SYSTEM = f"""You describe screenshots from a parcel map viewer for {VISION_PLACE}. The screenshot shows the map as the user sees it, captured straight down with north at the top: a basemap or aerial imagery, parcel boundaries, and any overlays that are turned on (flood zones, wetlands, soils, contours, hillshade). A selected parcel, if any, is drawn with a highlighted outline.

Rules:
- Describe what is visible in the image. Don't invent features you can't see.
- When you can't be certain what something is, give your best identification with how sure you are and the visual cue it rests on, e.g. "likely ballfields (diamond-shaped dirt infields)" or "possibly a pond (dark, smooth, round)". Don't just say it can't be confirmed.
- Use the view width and the parcel's known acreage, when given, as your scale for sizes and distances.
- When the map is zoomed out too far, or the imagery is too coarse to answer, say so plainly and suggest zooming in.
- Name the layers you can see when they support your answer.
- Never estimate property values, never identify or speculate about people, and never treat what you see as a survey or legal determination.
- Answer in at most 6 plain sentences; fewer is better when the question is narrow. No headings, lists, or emoji."""


def _user_text(
    question: str | None,
    parcel: dict | None,
    layers: list[str] | None,
    view_width_ft: float | None = None,
) -> str:
    lines = []
    if view_width_ft:
        lines.append(f"The view is about {round(view_width_ft):,} ft across from west to east.")
    if parcel:
        facts = []
        if parcel.get("pin"):
            facts.append(f"PIN {parcel['pin']}")
        if parcel.get("site_address"):
            facts.append(f"address {parcel['site_address']}")
        if parcel.get("acres") is not None:
            facts.append(f"{parcel['acres']:.2f} acres")
        if parcel.get("municipality"):
            facts.append(str(parcel["municipality"]))
        if facts:
            lines.append("Selected parcel (from the tax roll): " + ", ".join(facts) + ".")
    if layers:
        lines.append("Layers turned on: " + ", ".join(layers) + ".")
    if question:
        lines.append(f"Question to answer from the image: {question}")
    else:
        lines.append(
            "Give a general description: the selected parcel's shape and land cover, its "
            "apparent use, any structures, driveways or site features you can see, and the "
            "surrounding land uses. If no parcel is selected, describe the area in view."
        )
    return "\n".join(lines)


def run_describe_view(
    image: bytes,
    media_type: str,
    question: str | None = None,
    parcel: dict | None = None,
    layers: list[str] | None = None,
    view_width_ft: float | None = None,
) -> dict:
    """Ask the vision model about one map screenshot. Returns {description, model};
    raises VisionRefused on a refusal, and lets API errors propagate."""
    kwargs = {
        "model": VISION_MODEL,
        "max_tokens": VISION_MAX_TOKENS,
        "system": VISION_SYSTEM,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": base64.standard_b64encode(image).decode("ascii"),
                        },
                    },
                    {"type": "text", "text": _user_text(question, parcel, layers, view_width_ft)},
                ],
            }
        ],
        # A declined request is retried server-side on Anthropic's recommended
        # fallback model instead of failing the look.
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
    }
    if VISION_EFFORT:
        kwargs["output_config"] = {"effort": VISION_EFFORT}
    response = _create_message("vision", **kwargs)
    if response.stop_reason == "refusal":
        raise VisionRefused("the model declined to describe the image")
    text = "".join(b.text for b in response.content if getattr(b, "type", None) == "text").strip()
    if not text:
        raise VisionRefused("the model returned no description")
    return {"description": text, "model": getattr(response, "model", VISION_MODEL)}
