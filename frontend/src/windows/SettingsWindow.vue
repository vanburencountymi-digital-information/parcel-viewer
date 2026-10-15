<!-- Settings: display and accessibility preferences for this device. Every change applies
     at once through the hook that owns it (the prefs, PV_COORDS, PS_HINTS, and admin-menu.js's
     PV_SCHEME / PV_GLASS / PV_A11Y), which also saves it. Any hook may be missing; its
     control then just shows the default. -->
<script setup>
import { ref } from 'vue';
import FormField from './FormField.vue';

const props = defineProps({
  prefs: { type: Object, default: null },    // PV_PREFS: area units, basemap, orbit, reactions, mood
  coords: { type: Object, default: null },   // PV_COORDS (map.js)
  hints: { type: Object, default: null },    // PS_HINTS (hints.js)
  scheme: { type: Object, default: null },   // PV_SCHEME
  glass: { type: Object, default: null },    // PV_GLASS
  a11y: { type: Object, default: null },     // PV_A11Y
});

const call = (obj, fn, ...args) => (obj && typeof obj[fn] === 'function' ? obj[fn](...args) : undefined);

const SCHEMES = [
  { id: 'terracotta', label: 'Terracotta', sw: '#A3473B' },
  { id: 'forest', label: 'Forest', sw: '#2F6B4F' },
  { id: 'ocean', label: 'Ocean', sw: '#1F5E80' },
  { id: 'slate', label: 'Slate', sw: '#475569' },
  { id: 'plum', label: 'Plum', sw: '#7A3B6B' },
  { id: 'crimson', label: 'Crimson', sw: '#B11E2F' },
];
const A11Y_FLAGS = [
  ['contrast', 'High contrast', 'Darker text and stronger outlines.'],
  ['solid', 'Reduce transparency', 'Make panels solid instead of glass.'],
  ['font', 'Legible font', 'Switch to a high-legibility typeface (Atkinson Hyperlegible).'],
  ['motion', 'Reduce motion', 'Turn off animations and transitions.'],
];
const TEXT_SIZES = [['1', 'Default'], ['1.15', 'Large'], ['1.3', 'Larger']];

const p = props.prefs;
const areaUnits = ref(call(p, 'getAreaUnits') || 'acres');
const coordFmt = ref(call(props.coords, 'getFormat') || 'dd');
const basemap = ref(call(p, 'getBasemap') || 'light');
const glassPct = ref(Math.round((call(props.glass, 'get') || 0.62) * 100));
const scheme = ref(call(props.scheme, 'get') || 'terracotta');
const orbit = ref(!(p && p.getCinematicOrbit) || !!p.getCinematicOrbit());
const reactions = ref(call(p, 'getMapReactions') || 'subtle');
const mood = ref(call(p, 'getMapMood') || 'none');
const hintsOn = ref(!(props.hints && props.hints.isEnabled) || !!props.hints.isEnabled());
const flags = ref(Object.fromEntries(A11Y_FLAGS.map(([n]) => [n, !!call(props.a11y, 'getFlag', n)])));
const ts = call(props.a11y, 'getTextScale') || 1;
const textSize = ref((TEXT_SIZES.find(([v]) => Math.abs(ts - Number(v)) < 0.001) || TEXT_SIZES[0])[0]);

function resetHints() {
  try { call(props.hints, 'reset'); } catch { /* hints.js not usable */ }
  hintsOn.value = true;
}
function setHints() {
  try { call(props.hints, 'setEnabled', hintsOn.value); } catch { /* hints.js not usable */ }
}
function pickScheme(id) {
  call(props.scheme, 'set', id);
  scheme.value = id;
}
</script>

<template>
  <p class="pv-modal-lead">Display preferences for this device.</p>
  <div class="pv-form">
    <FormField label="Area units">
      <select id="pv-set-area" v-model="areaUnits" class="pv-input" @change="call(prefs, 'setAreaUnits', areaUnits)">
        <option value="acres">Acres</option>
        <option value="sqft">Square feet</option>
      </select>
    </FormField>
    <FormField label="Coordinate format">
      <select id="pv-set-coord" v-model="coordFmt" class="pv-input" @change="call(coords, 'setFormat', coordFmt)">
        <option value="dd">Decimal degrees</option>
        <option value="dms">Degrees / minutes / seconds</option>
        <option value="spc">State Plane (Michigan South)</option>
      </select>
    </FormField>
    <FormField label="Default basemap">
      <select id="pv-set-basemap" v-model="basemap" class="pv-input" @change="call(prefs, 'setBasemap', basemap)">
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="aerial">Aerial imagery</option>
      </select>
    </FormField>
    <FormField label="Panel glass">
      <input
        id="pv-set-glass" v-model.number="glassPct" type="range" class="pv-range" min="40" max="100" step="2"
        aria-label="Panel transparency, lower is more see-through" @input="call(glass, 'set', glassPct / 100)"
      >
      <span class="pv-range-hint">Lower = more see-through</span>
    </FormField>
    <FormField label="Color scheme" group>
      <div class="pv-scheme-row" role="group" aria-label="Color scheme">
        <button
          v-for="s in SCHEMES" :key="s.id" type="button" class="pv-scheme-swatch" :data-scheme="s.id"
          :style="{ '--sw': s.sw }" :title="s.label" :aria-label="`${s.label} color scheme`"
          :aria-pressed="String(s.id === scheme)" @click="pickScheme(s.id)"
        ></button>
      </div>
    </FormField>
    <FormField label="Search arrival" group>
      <label class="pv-a11y-row" style="margin:0">
        <input id="pv-set-orbit" v-model="orbit" type="checkbox" @change="call(prefs, 'setCinematicOrbit', orbit)">
        <span><span class="pv-a11y-lbl">Spin around parcel</span>
          <span class="pv-a11y-desc">After a search, orbit the parcel once. Turn off for a quick fly-in.</span></span>
      </label>
    </FormField>
    <FormField label="Map reactions">
      <select id="pv-set-reactions" v-model="reactions" class="pv-input" @change="call(prefs, 'setMapReactions', reactions)">
        <option value="off">Off</option>
        <option value="subtle">Subtle</option>
        <option value="full">Full</option>
      </select>
      <span class="pv-range-hint">Selecting a parcel dims the rest to focus it. Subtle = instant · Full = animated · Off = static.</span>
    </FormField>
    <FormField label="Map mood">
      <select id="pv-set-mood" v-model="mood" class="pv-input" @change="call(prefs, 'setMapMood', mood)">
        <option value="none">None</option>
        <option value="antique">Antique</option>
      </select>
      <span class="pv-range-hint">A cartographic mood above the color scheme. Antique = parchment ground &amp; hairline strokes (opt-in).</span>
    </FormField>
    <FormField label="Hints" group>
      <label class="pv-a11y-row" style="margin:0">
        <input id="pv-set-hints" v-model="hintsOn" type="checkbox" @change="setHints">
        <span><span class="pv-a11y-lbl">Show hints</span>
          <span class="pv-a11y-desc">Tips and one-tap shortcuts on the map for getting around.</span></span>
      </label>
      <button id="pv-hints-reset" type="button" class="pv-hints-reset-btn" @click="resetHints">Reset hints</button>
    </FormField>
  </div>

  <p class="pv-settings-h">Accessibility</p>
  <FormField label="Text size">
    <select id="pv-a11y-ts" v-model="textSize" class="pv-input" @change="call(a11y, 'setTextScale', Number(textSize))">
      <option v-for="[v, l] in TEXT_SIZES" :key="v" :value="v">{{ l }}</option>
    </select>
  </FormField>
  <div class="pv-a11y-list">
    <label v-for="[n, label, desc] in A11Y_FLAGS" :key="n" class="pv-a11y-row">
      <input v-model="flags[n]" type="checkbox" class="pv-a11y-chk" :data-a="n" @change="call(a11y, 'setFlag', n, flags[n])">
      <span><span class="pv-a11y-lbl">{{ label }}</span><span class="pv-a11y-desc">{{ desc }}</span></span>
    </label>
  </div>
  <FormField label="Language">
    <select id="pv-a11y-lang" class="pv-input">
      <option value="en" selected>English</option>
      <option value="es" disabled>Español — coming soon</option>
    </select>
  </FormField>
  <p class="pv-modal-note">Changes apply immediately and are saved on this device. The header button toggles all of these at once.</p>
  <!-- Low-key staff entry point to the admin console (DIC-463). The console itself requires
       a DICE sign-in; this is just a discreet launcher. -->
  <div class="pv-staff-row">
    <a class="pv-staff-link" href="/admin/" target="_blank" rel="noopener">Staff sign-in / Admin <span aria-hidden="true">↗</span></a>
  </div>
</template>
