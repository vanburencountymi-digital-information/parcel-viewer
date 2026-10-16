<!-- The Measurement Tools pane (DIC-2389; was static markup wired by measure-tool.js).
     Measuring stays on the map side: this pane picks the tool and the settings through
     PS_MEASURE_TOOL and follows it, including tools opened elsewhere (Map Buddy). The
     Dimension Parcel options keep their ids: measure-tool.js reads them when it runs. The
     results HUD over the map is still measure-tool.js's. -->
<script setup>
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps({
  tool: { type: Object, required: true },             // PS_MEASURE_TOOL
  annotations: { type: Object, default: null },       // PS_ANNOTATION_STORE (undo/redo follow it)
  undo: { type: Object, default: null },              // PS_UNDO_REDO
  confirm: { type: Function, default: (msg) => globalThis.confirm(msg) },
  alert: { type: Function, default: (msg) => globalThis.alert(msg) },
});

// [tool name, button id, label, title]
const BASIC = [
  ['measure-area', 'msr-tool-area', 'Measure Area', 'Draw a polygon and measure its area'],
  ['measure-dist', 'msr-tool-dist', 'Measure Dist.', 'Click waypoints to measure distance (double-click to finish)'],
  ['coordinates', 'msr-tool-coords', 'Coordinates', 'Click any point to get its coordinates'],
  ['dimension-line', 'msr-tool-dimline', 'Dim. Line', 'Click two points to place a dimension line with arrowheads'],
];
const QUERY = [
  ['bearing-dist', 'msr-tool-bearing', 'Bearing & Dist.', 'Two clicks — measure bearing and distance between points'],
  ['perpendicular', 'msr-tool-perp', 'Perpendicular', 'Three clicks — measure perpendicular distance from a point to a line'],
  ['arc-radius', 'msr-tool-arc', 'Arc / Radius', 'Three clicks — fit a circular arc and compute radius, delta, chord'],
];

const active = ref(props.tool.getActiveTool());
const settings = ref(props.tool.getSettings());
const advanced = ref(props.tool.isAdvancedExpanded());
const canUndo = ref(false);
const canRedo = ref(false);

function fromTool() {
  active.value = props.tool.getActiveTool();
  settings.value = props.tool.getSettings();
  advanced.value = props.tool.isAdvancedExpanded();
}
function fromHistory() {
  canUndo.value = !!(props.undo && props.undo.canUndo);
  canRedo.value = !!(props.undo && props.undo.canRedo);
}
const offs = [props.tool.subscribe(fromTool)];
if (props.annotations) offs.push(props.annotations.subscribe(fromHistory));
fromHistory();
onBeforeUnmount(() => offs.forEach((off) => off && off()));

const set = (key, value) => props.tool.setSetting(key, value);

function doUndo() { if (props.undo && props.undo.canUndo) props.undo.undo(); fromHistory(); }
function doRedo() { if (props.undo && props.undo.canRedo) props.undo.redo(); fromHistory(); }
function clearAll() {
  if (!props.confirm('Clear all measurement annotations? This cannot be undone after confirmation.')) return;
  props.tool.clearAllMeasurements();
}
</script>

<template>
  <div class="mcp-pane-title" role="heading" aria-level="3">Measurement Tools</div>

  <div class="msr-settings">
    <div class="msr-setting-row">
      <span class="msr-setting-label">Annotate with</span>
      <label class="msr-chk-label"><input id="msr-ann-dist" type="checkbox" :checked="settings.annotateDistance" @change="set('annotateDistance', $event.target.checked)"> Distance</label>
      <label class="msr-chk-label"><input id="msr-ann-bearing" type="checkbox" :checked="settings.annotateBearing" @change="set('annotateBearing', $event.target.checked)"> Bearing</label>
    </div>
    <div class="msr-setting-row">
      <span class="msr-setting-label">Bearing format</span>
      <div class="msr-toggle-group msr-bearing-fmt-grp" data-setting="bearingFormat">
        <button
          v-for="[v, label] in [['quadrant', 'Quadrant'], ['azimuth', 'Azimuth']]" :key="v" class="msr-toggle"
          :class="{ active: settings.bearingFormat === v }" :data-value="v" :aria-pressed="String(settings.bearingFormat === v)"
          @click="set('bearingFormat', v)"
        >{{ label }}</button>
      </div>
    </div>
    <div class="msr-setting-row">
      <span class="msr-setting-label">Units</span>
      <div class="msr-toggle-group msr-units-grp" data-setting="units">
        <button
          v-for="[v, label] in [['feet', 'Feet'], ['miles', 'Miles']]" :key="v" class="msr-toggle"
          :class="{ active: settings.units === v }" :data-value="v" :aria-pressed="String(settings.units === v)"
          @click="set('units', v)"
        >{{ label }}</button>
      </div>
    </div>
  </div>

  <div class="msr-section-label">Basic Tools</div>
  <div class="msr-tools-grid">
    <button
      v-for="[t, id, label, title] in BASIC" :id="id" :key="t" class="msr-tool-btn" :class="{ active: active === t }"
      :title="title" :aria-pressed="String(active === t)" @click="tool.toggleTool(t)"
    >
      <svg v-if="t === 'measure-area'" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="1.5" width="10" height="10" rx="1" /></svg>
      <svg v-else-if="t === 'measure-dist'" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="1" y1="11" x2="5" y2="5" /><line x1="5" y1="5" x2="9" y2="8" /><line x1="9" y1="8" x2="12" y2="3" /></svg>
      <svg v-else-if="t === 'coordinates'" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="6.5" y1="1" x2="6.5" y2="12" /><line x1="1" y1="6.5" x2="12" y2="6.5" /><circle cx="6.5" cy="6.5" r="2.5" /></svg>
      <svg v-else width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="1" y1="6.5" x2="12" y2="6.5" /><polyline points="3,4 1,6.5 3,9" fill="none" /><polyline points="10,4 12,6.5 10,9" fill="none" /></svg>
      {{ label }}
    </button>
  </div>

  <button id="msr-adv-toggle" class="msr-adv-toggle-btn" :aria-expanded="String(advanced)" aria-controls="msr-advanced-body" @click="tool.setAdvancedExpanded(!advanced)">
    {{ advanced ? '▼' : '▶' }} Advanced Tools
  </button>
  <div id="msr-advanced-body" :hidden="!advanced">
    <div class="msr-subsection-label">Query</div>
    <div class="msr-tools-grid">
      <button
        v-for="[t, id, label, title] in QUERY" :id="id" :key="t" class="msr-tool-btn" :class="{ active: active === t }"
        :title="title" :aria-pressed="String(active === t)" @click="tool.toggleTool(t)"
      >
        <svg v-if="t === 'bearing-dist'" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="6.5" cy="6.5" r="5" /><line x1="6.5" y1="1.5" x2="6.5" y2="4" /><line x1="6.5" y1="6.5" x2="9" y2="4" /></svg>
        <svg v-else-if="t === 'perpendicular'" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="1" y1="10" x2="12" y2="10" /><line x1="6.5" y1="10" x2="6.5" y2="3" /><rect x="5.5" y="9" width="2" height="2" fill="none" stroke="currentColor" stroke-width="1" /></svg>
        <svg v-else width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 11 Q6.5 1 11 11" /></svg>
        {{ label }}
      </button>
    </div>

    <div class="msr-subsection-label">Linear</div>
    <div class="msr-tools-grid">
      <button
        id="msr-tool-running" class="msr-tool-btn" :class="{ active: active === 'running-dim' }"
        title="Click waypoints — labels each segment with individual and cumulative lengths" :aria-pressed="String(active === 'running-dim')"
        @click="tool.toggleTool('running-dim')"
      >
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><polyline points="1,10 4,5 8,7 12,3" /><line x1="4" y1="4" x2="4" y2="6" /><line x1="8" y1="6" x2="8" y2="8" /></svg>
        Running Dim.
      </button>
      <button id="msr-tool-offset" class="msr-tool-btn msr-tool-btn-stub" title="Coming soon — offset/parallel line at a set distance" @click="alert('Offset Line is coming in a future update.')">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="2 1.5" aria-hidden="true"><line x1="1" y1="9" x2="12" y2="4" /><line x1="1" y1="12" x2="12" y2="7" /></svg>
        Offset Line
      </button>
      <button
        id="msr-tool-angle" class="msr-tool-btn" :class="{ active: active === 'angle' }" title="Three clicks — measure the angle at a vertex"
        :aria-pressed="String(active === 'angle')" @click="tool.toggleTool('angle')"
      >
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="1" y1="11" x2="12" y2="11" /><line x1="3" y1="11" x2="10" y2="3" /><path d="M5.5 11 A3 3 0 0 0 7.8 8.5" stroke-dasharray="none" /></svg>
        Angle
      </button>
    </div>

    <div class="msr-subsection-label">Parcel</div>
    <div class="msr-tools-grid">
      <button
        id="msr-tool-autodim" class="msr-tool-btn msr-tool-btn-wide" :class="{ active: active === 'auto-dim' }"
        title="Auto-dimension all sides of a parcel with labels" :aria-pressed="String(active === 'auto-dim')" @click="tool.toggleTool('auto-dim')"
      >
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M6.5 1L12 4v5L6.5 12 1 9V4z" /><line x1="1" y1="6.5" x2="12" y2="6.5" /></svg>
        Dimension Parcel
      </button>
    </div>

    <!-- measure-tool.js reads these by id when it dimensions a parcel. -->
    <div id="msr-autodim-opts" class="msr-autodim-opts" :hidden="active !== 'auto-dim'">
      <div class="msr-opt-row">
        <label class="msr-opt-label" for="msr-ad-label-content">Label content</label>
        <select id="msr-ad-label-content" class="msr-mini-sel">
          <option value="both">Distance + Bearing</option>
          <option value="distance">Distance only</option>
          <option value="bearing">Bearing only</option>
        </select>
      </div>
      <div class="msr-opt-row">
        <label class="msr-opt-label" for="msr-ad-label-pos">Label position</label>
        <select id="msr-ad-label-pos" class="msr-mini-sel">
          <option value="outside">Outside parcel</option>
          <option value="inside">Inside parcel</option>
          <option value="online">On line</option>
        </select>
      </div>
      <div class="msr-opt-row">
        <label class="msr-opt-label" for="msr-ad-min-seg">Min. segment</label>
        <input id="msr-ad-min-seg" type="number" class="msr-mini-num" value="10" min="0" step="1"> ft
      </div>
      <div class="msr-opt-row">
        <label class="msr-opt-label" for="msr-ad-collinear">Collinearity</label>
        <input id="msr-ad-collinear" type="number" class="msr-mini-num" value="0.5" min="0" max="5" step="0.1">°
      </div>
      <div class="msr-opt-row">
        <label class="msr-opt-label" for="msr-ad-group">Group name</label>
        <input id="msr-ad-group" type="text" class="msr-group-name-inp" value="{PIN} Dimensions">
      </div>
    </div>
  </div>

  <div class="msr-footer">
    <div class="msr-footer-btns">
      <button id="msr-undo-btn" class="drw-icon-btn" title="Undo (Ctrl+Z)" :disabled="!canUndo" @click="doUndo">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 6.5 A4.5 4.5 0 1 1 6.5 11" /><polyline points="2,4 2,6.5 4.5,6.5" /></svg>
      </button>
      <button id="msr-redo-btn" class="drw-icon-btn" title="Redo (Ctrl+Shift+Z)" :disabled="!canRedo" @click="doRedo">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M11 6.5 A4.5 4.5 0 1 0 6.5 11" /><polyline points="11,4 11,6.5 8.5,6.5" /></svg>
      </button>
      <button id="msr-clear-all-btn" class="drw-clear-btn" title="Clear all measurement annotations" @click="clearAll">&#x1F5D1; Clear Measurements</button>
    </div>
  </div>
</template>
