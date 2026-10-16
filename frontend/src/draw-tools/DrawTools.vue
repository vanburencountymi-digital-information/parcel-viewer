<!-- The Drawing Tools pane (DIC-2389; was static markup wired by drawing-tools.js). The
     drawing itself stays on the map side: this pane picks the tool and the style through
     PS_DRAWING_TOOLS, and shows the layer groups, undo/redo and snapping from their own
     modules. It follows changes made elsewhere too (Map Buddy picks tools and styles). -->
<script setup>
import { onBeforeUnmount, reactive, ref } from 'vue';

const props = defineProps({
  tools: { type: Object, required: true },            // PS_DRAWING_TOOLS
  annotations: { type: Object, default: null },       // PS_ANNOTATION_STORE
  undo: { type: Object, default: null },              // PS_UNDO_REDO
  snapping: { type: Object, default: null },          // PS_SNAPPING_ENGINE
  confirm: { type: Function, default: (msg) => globalThis.confirm(msg) },
  ask: { type: Function, default: (msg) => globalThis.prompt(msg) },
});

const STROKE_COLORS = ['#1d4ed8', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#1f2937'];
const FILL_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a78bfa', '#f472b6', '#38bdf8', '#9ca3af'];
// [tool, label, title] per row
const EDIT = [['select', 'Select', 'Select, move, and rotate annotations (Delete to remove)']];
const DRAW = [
  ['point', 'Point', 'Place a point marker'],
  ['polyline', 'Line', 'Draw a polyline (click vertices, double-click to finish)'],
  ['polygon', 'Shape', 'Draw a polygon (click vertices, double-click to finish)'],
  ['circle', 'Circle', 'Draw a circle (click center, click radius)'],
  ['freehand', 'Free', 'Freehand draw (hold and drag)'],
];
const ANNOTATE = [['text', 'Label', 'Place a text label'], ['callout', 'Callout', 'Place a callout / leader line']];

const activeTool = ref(props.tools.getActiveDrawTool());
const style = reactive({ ...props.tools.getCurrentStyle() });
const styleOpen = ref(false);
const groups = ref([]);
const activeGroup = ref('Default');
const visible = ref({});
const canUndo = ref(false);
const canRedo = ref(false);
const snapOn = ref(props.snapping ? !!props.snapping.config.enabled : true);
const gridOn = ref(props.snapping ? !!props.snapping.config.targets.gridPoints : false);

function fromTools() {
  activeTool.value = props.tools.getActiveDrawTool();
  Object.assign(style, props.tools.getCurrentStyle());
}
function fromStore() {
  if (props.annotations) {
    const s = props.annotations.getState();
    groups.value = s.layerGroups;
    activeGroup.value = s.activeLayerGroup;
    visible.value = { ...s.layerVisibility };
  }
  if (props.undo) {
    canUndo.value = !!props.undo.canUndo;
    canRedo.value = !!props.undo.canRedo;
  }
}
const offs = [props.tools.subscribe(fromTools)];
if (props.annotations) offs.push(props.annotations.subscribe(fromStore));
fromStore();
onBeforeUnmount(() => offs.forEach((off) => off && off()));

const pick = (tool) => props.tools.setActiveDrawTool(tool);
const setStyle = (key, value) => props.tools.setStyle({ [key]: value });

function doUndo() { props.undo.undo(); fromStore(); }
function doRedo() { props.undo.redo(); fromStore(); }

function clearAll() {
  if (!props.annotations || !props.annotations.getState().annotations.features.length) return;
  if (!props.confirm('Clear all annotations? This cannot be undone.')) return;
  props.tools.clearAll();
}

function setSnap(on) { snapOn.value = on; props.tools.setSnapping(on); }
function setGrid(on) {
  gridOn.value = on;
  if (props.snapping) props.snapping.configure({ targets: { gridPoints: on } });
}

function addGroup() {
  const name = props.ask('New layer group name:');
  if (name && name.trim()) {
    props.annotations.addLayerGroup(name.trim());
    props.annotations.setActiveLayerGroup(name.trim());
  }
}
</script>

<template>
  <div class="mcp-pane-title" role="heading" aria-level="3">Drawing Tools</div>

  <div class="drw-section-label">Edit</div>
  <div class="drw-tools-row">
    <button
      v-for="[t, label, title] in EDIT" :id="`drw-tool-${t}`" :key="t" class="drw-tool-btn" :class="{ active: activeTool === t }"
      :title="title" :aria-pressed="String(activeTool === t)" @click="pick(t)"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <path d="M2 2 L2 9 L4.5 7 L6 10.5 L7.5 9.8 L6 6.3 L9 6.3 Z" fill="currentColor" stroke="none" fill-opacity="0.8" />
      </svg>
      {{ label }}
    </button>
  </div>

  <div class="drw-section-label">Draw</div>
  <div class="drw-tools-row">
    <button
      v-for="[t, label, title] in DRAW" :id="`drw-tool-${t}`" :key="t" class="drw-tool-btn" :class="{ active: activeTool === t }"
      :title="title" :aria-pressed="String(activeTool === t)" @click="pick(t)"
    >
      <svg v-if="t === 'point'" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="4" fill="currentColor" fill-opacity="0.25" stroke="currentColor" stroke-width="1.5" /><circle cx="6" cy="6" r="1.5" fill="currentColor" />
      </svg>
      <svg v-else-if="t === 'polyline'" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><polyline points="1,10 4,4 8,7 11,2" /></svg>
      <svg v-else-if="t === 'polygon'" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><polygon points="6,1 11,4 10,10 2,10 1,4" /></svg>
      <svg v-else-if="t === 'circle'" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="6" cy="6" r="4.5" /></svg>
      <svg v-else width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M1 8 C2 5, 4 9, 6 6 C8 3, 9 7, 11 4" /></svg>
      {{ label }}
    </button>
  </div>

  <div class="drw-section-label">Annotate</div>
  <div class="drw-tools-row drw-tools-row-annotate">
    <button
      v-for="[t, label, title] in ANNOTATE" :id="`drw-tool-${t}`" :key="t" class="drw-tool-btn" :class="{ active: activeTool === t }"
      :title="title" :aria-pressed="String(activeTool === t)" @click="pick(t)"
    >
      <svg v-if="t === 'text'" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><text x="2" y="10" font-size="10" font-family="serif" font-weight="bold">T</text></svg>
      <svg v-else width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <line x1="2" y1="10" x2="8" y2="4" /><text x="7" y="4" font-size="5" fill="currentColor" stroke="none" font-family="sans-serif">T</text><polygon points="2,10 4,8 3,11" fill="currentColor" stroke="none" />
      </svg>
      {{ label }}
    </button>
  </div>

  <div class="drw-global-row">
    <button id="drw-undo-btn" class="drw-icon-btn" title="Undo (Ctrl+Z)" :disabled="!canUndo" @click="doUndo">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 6.5 A4.5 4.5 0 1 1 6.5 11" /><polyline points="2,4 2,6.5 4.5,6.5" /></svg>
    </button>
    <button id="drw-redo-btn" class="drw-icon-btn" title="Redo (Ctrl+Shift+Z)" :disabled="!canRedo" @click="doRedo">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M11 6.5 A4.5 4.5 0 1 0 6.5 11" /><polyline points="11,4 11,6.5 8.5,6.5" /></svg>
    </button>
    <button
      id="drw-style-toggle" class="drw-style-toggle-btn" :class="{ active: styleOpen }" title="Toggle style picker"
      :aria-expanded="String(styleOpen)" aria-controls="drw-style-picker" @click="styleOpen = !styleOpen"
    >Style</button>
    <button id="drw-clear-all-btn" class="drw-clear-btn" title="Clear all annotations" @click="clearAll">Clear</button>
  </div>

  <div class="drw-toggles">
    <label class="drw-toggle-row"><input id="drw-snap-toggle" type="checkbox" :checked="snapOn" @change="setSnap($event.target.checked)"> Snapping</label>
    <label class="drw-toggle-row"><input id="drw-grid-toggle" type="checkbox" :checked="gridOn" @change="setGrid($event.target.checked)"> Grid</label>
  </div>

  <div id="drw-style-picker" class="drw-style-picker" :hidden="!styleOpen">
    <div class="drw-style-section">
      <div class="drw-style-section-label">Stroke</div>
      <div id="drw-stroke-swatches" class="drw-color-grid">
        <button
          v-for="c in STROKE_COLORS" :key="c" type="button" class="drw-swatch" :class="{ active: style.strokeColor === c }"
          :style="{ background: c }" :title="c" @click="setStyle('strokeColor', c)"
        ></button>
      </div>
      <div class="drw-style-row">
        <input id="drw-stroke-custom" type="color" class="drw-color-input" title="Custom stroke color" :value="style.strokeColor" @input="setStyle('strokeColor', $event.target.value)">
        <select id="drw-stroke-dash" class="drw-mini-select" title="Line style" :value="style.strokeDash" @change="setStyle('strokeDash', $event.target.value)">
          <option value="solid">Solid</option>
          <option value="dashed">Dashed</option>
          <option value="dotted">Dotted</option>
        </select>
        <input id="drw-stroke-width" type="range" min="1" max="8" step="1" class="drw-slider" title="Stroke width" :value="style.strokeWidth" @input="setStyle('strokeWidth', parseInt($event.target.value, 10))">
        <span id="drw-stroke-width-label" class="drw-slider-label">{{ style.strokeWidth }}px</span>
      </div>
    </div>
    <div class="drw-style-section">
      <div class="drw-style-section-label">Fill</div>
      <div id="drw-fill-swatches" class="drw-color-grid">
        <button
          v-for="c in FILL_COLORS" :key="c" type="button" class="drw-swatch" :class="{ active: style.fillColor === c }"
          :style="{ background: c }" :title="c" @click="setStyle('fillColor', c)"
        ></button>
      </div>
      <div class="drw-style-row">
        <input id="drw-fill-custom" type="color" class="drw-color-input" title="Custom fill color" :value="style.fillColor" @input="setStyle('fillColor', $event.target.value)">
        <input id="drw-fill-opacity" type="range" min="0" max="100" step="5" class="drw-slider" title="Fill opacity" :value="Math.round(style.fillOpacity * 100)" @input="setStyle('fillOpacity', parseInt($event.target.value, 10) / 100)">
        <span id="drw-fill-opacity-label" class="drw-slider-label">{{ Math.round(style.fillOpacity * 100) }}%</span>
      </div>
    </div>
    <div class="drw-style-section">
      <div class="drw-style-section-label">Text &amp; Arrows</div>
      <div class="drw-style-row">
        <span class="drw-slider-caption">Size</span>
        <input id="drw-font-size" type="range" min="8" max="32" step="1" class="drw-slider" title="Font size" :value="style.fontSize" @input="setStyle('fontSize', parseInt($event.target.value, 10))">
        <span id="drw-font-size-label" class="drw-slider-label">{{ style.fontSize }}px</span>
      </div>
      <div class="drw-arrow-row">
        <label class="drw-toggle-row"><input id="drw-arrow-start" type="checkbox" :checked="style.arrowStart" @change="setStyle('arrowStart', $event.target.checked)"> Arrow Start</label>
        <label class="drw-toggle-row"><input id="drw-arrow-end" type="checkbox" :checked="style.arrowEnd" @change="setStyle('arrowEnd', $event.target.checked)"> Arrow End</label>
      </div>
    </div>
  </div>

  <div class="drw-section-label drw-section-label-gap">Layers</div>
  <div id="drw-layer-groups-list" class="drw-layer-groups-list">
    <div v-for="name in groups" :key="name" class="drw-group-row" :class="{ active: name === activeGroup }">
      <input
        type="checkbox" class="drw-group-check" title="Toggle visibility" :checked="visible[name] !== false"
        @change="annotations.setLayerVisibility(name, $event.target.checked)"
      >
      <span
        class="drw-group-name" title="Set as active layer" role="button" tabindex="0"
        @click="annotations.setActiveLayerGroup(name)" @keydown.enter.prevent="annotations.setActiveLayerGroup(name)"
        @keydown.space.prevent="annotations.setActiveLayerGroup(name)"
      >{{ name }}</span>
      <button
        v-if="name !== 'Default'" type="button" class="drw-group-delete" title="Delete group (annotations move to Default)"
        @click="annotations.removeLayerGroup(name)"
      >✕</button>
    </div>
  </div>
  <button id="drw-add-group-btn" type="button" class="drw-add-group-btn" @click="addGroup">+ New Group</button>
</template>
