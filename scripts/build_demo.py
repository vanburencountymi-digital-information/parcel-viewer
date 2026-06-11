"""Build demo/index.html from parcel-studio index (one-time helper)."""
import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / ".." / "parcel-studio" / "frontend" / "index.html"
SRC = Path(r"C:\Users\DID User\Documents\parcel-studio\frontend\index.html")
OUT = Path(__file__).resolve().parents[1] / "demo" / "index.html"

text = SRC.read_text(encoding="utf-8")

text = re.sub(
    r"      <!-- COOG placeholder -->",
    "",
    text,
)
text = re.sub(
    r"      <!-- COGO Bearing-Distance Traverse Panel -->.*?(?=      <!-- Measurement HUD)",
    "",
    text,
    flags=re.S,
)

text = text.replace("Parcel Studio — Van Buren County", "Parcel Viewer — Van Buren County")
text = text.replace("/css/style.css", "/frontend/public/css/style.css")
text = text.replace('  <link rel="stylesheet" href="/css/parcel-studio.css">\n', "")

text = re.sub(
    r'        <span id="ps-operator-badge".*?</button>\n',
    "",
    text,
    flags=re.S,
)

text = re.sub(
    r'          <button class="mcp-tab" data-tab="edits".*?</button>\n',
    "",
    text,
    flags=re.S,
)

text = re.sub(
    r"          <!-- Parcel Edits pane.*?          <!-- Select pane -->",
    "          <!-- Select pane -->",
    text,
    flags=re.S,
)

text = re.sub(
    r'            <div class="drw-section-label">COGO</div>.*?            <div id="cogo-edit-bar".*?</div>\n\n',
    "",
    text,
    flags=re.S,
)

text = re.sub(r"  <!-- Login modal -->.*?(?=  <script>)", "", text, flags=re.S)

for old, new in [
    ("/js/auth.js", ""),
    ("/js/drawing/", "/frontend/public/js/drawing/"),
    ("/js/map.js", "/frontend/public/js/map.js"),
    ("/js/parcel-edits.js", ""),
    ("/js/parcel-labels.js", "/frontend/public/js/parcel-labels.js"),
    ("/js/overlay-layers.js", "/frontend/public/js/overlay-layers.js"),
    ("/js/legend-panel.js", "/frontend/public/js/legend-labels.js"),
    ("/js/wms-feature-info.js", "/frontend/public/js/wms-feature-info.js"),
]:
    text = text.replace(old, new)

text = text.replace("/frontend/public/js/legend-labels.js", "/frontend/public/js/legend-panel.js")

text = re.sub(r"  <!-- Auth.*?\n", "", text)
text = re.sub(r'  <script src=""></script>\n', "", text)
text = re.sub(r"  <!-- COGO:.*?\n", "", text)
text = re.sub(
    r'  <script src="/frontend/public/js/drawing/arc-course.js"></script>\n',
    "",
    text,
)
text = re.sub(
    r'  <script src="/frontend/public/js/drawing/cogo-tool.js"></script>\n',
    "",
    text,
)
text = re.sub(
    r'  <script src="/frontend/public/js/drawing/backin-tool.js"></script>\n',
    "",
    text,
)

text = text.replace('class="ps-app"', 'class="pv-app"')
text = text.replace(
    'id="parcel-context" class="ps-status-strip"',
    'id="parcel-context" class="pv-status-strip"',
)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(text, encoding="utf-8")
print(f"Wrote {OUT} ({len(text.splitlines())} lines)")
