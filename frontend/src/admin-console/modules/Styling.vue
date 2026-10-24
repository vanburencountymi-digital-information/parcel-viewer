<!-- Styling (DIC-460 / DIC-503; a Vue module since DIC-2389, was admin.js renderStyling):
     the colour scheme, theme and basemap, per-layer styling, and the parcel labels. A
     picker chooses which layer the styling cards target, and the layer's geometry decides
     what they show: polygon → fill and stroke plus the choropleth (colour by an attribute,
     with its categories or stops), line → width, dash, casing and glow, point → radius
     and stroke. Every layer gets the label tool, driven by its tiles' attributes. -->
<script setup>
import { ref } from 'vue';
import ColorField from '../ColorField.vue';
import DraftField from '../DraftField.vue';
import DraftSelect from '../DraftSelect.vue';
import { useEditFlow } from '../edit-flow.js';
import ModuleFrame from '../ModuleFrame.vue';

const props = defineProps({ store: { type: Object, required: true } });
const state = props.store.state;
const flow = useEditFlow(props.store);

// Read at render time (state.rev: the draft changes in place, see CountyConfig.vue).
const C = () => (state.rev, props.store.current());
const S = () => C().styling || {};
const hasStyling = () => { const s = S(); return !!(s.schemes || s.layers || s.labels); };
const layers = () => S().layers || {};
const layerIds = () => Object.keys(layers());

// The focused layer (a view choice, not a draft edit): the picked one while it exists,
// else the first.
const picked = ref(null);
const selId = () => (picked.value && layers()[picked.value] ? picked.value : layerIds()[0]);
const lyr = () => layers()[selId()] || {};
const lyrLabel = () => lyr().label || selId() || 'layer';
const lp = () => 'styling.layers.' + selId();   // the config path of the focused layer
const sub = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), lyr()) || {};

const overlayFor = (id) => ((C().layers || {}).overlays || []).find((o) => o.id === id);
// Geometry from the layer's overlay registration; parcels are polygons; else a line or
// point style block says which.
function geomType(id = selId()) {
  if (id === 'parcels') return 'polygon';
  const ov = overlayFor(id);
  if (ov && ov.geomType) return String(ov.geomType).toLowerCase();
  if (layers()[id] && layers()[id].line) return 'line';
  if (layers()[id] && layers()[id].point) return 'point';
  return 'polygon';
}
// The attributes to label or colour by, from the layer's tiles.
function layerFields(id = selId()) {
  if (id === 'parcels') return ((layers().parcels || {}).choropleth || {}).fields || [];
  return (overlayFor(id) || {}).fields || [];
}
const GEOM_NOTE = { line: 'line — casing, dash & glow', point: 'point — radius & stroke', polygon: 'fill, stroke & choropleth' };

const shown = (v, sfx) => (v == null || v === '' ? '—' : v + (sfx ? ' ' + sfx : ''));

// [label, path under the layer, kind, unit or note] for each geometry's rows.
const ROWS = {
  polygon: [['Light — fill', 'paint.light.fill', 'color'], ['Light — stroke', 'paint.light.stroke', 'color'],
    ['Dark — fill', 'paint.dark.fill', 'color'], ['Dark — stroke', 'paint.dark.stroke', 'color']],
  line: [['Width', 'line.width', 'num', 'px'], ['Opacity', 'line.opacity', 'num'], ['Dash', 'line.dash', 'dash'],
    ['Casing width', 'line.casingWidth', 'num', null, 'outline under the line (0 = none)'],
    ['Glow width', 'line.glowWidth', 'num', null, 'blurred halo (0 = none)'],
    ['Light — line', 'line.light.color', 'color'], ['Light — casing', 'line.light.casingColor', 'color'], ['Light — glow', 'line.light.glowColor', 'color'],
    ['Dark — line', 'line.dark.color', 'color'], ['Dark — casing', 'line.dark.casingColor', 'color'], ['Dark — glow', 'line.dark.glowColor', 'color']],
  point: [['Radius', 'point.radius', 'num', 'px'], ['Stroke width', 'point.strokeWidth', 'num'],
    ['Light — fill', 'point.light.color', 'color'], ['Light — stroke', 'point.light.strokeColor', 'color'],
    ['Dark — fill', 'point.dark.color', 'color'], ['Dark — stroke', 'point.dark.strokeColor', 'color']],
};
const rowValue = (rel) => rel.split('.').reduce((o, k) => (o == null ? undefined : o[k]), lyr());

// The choropleth (polygon layers): colour by an attribute; categories for 'categorical',
// stops for 'graduated'.
const ch = () => lyr().choropleth || {};
const cp = () => lp() + '.choropleth';
const attrOptions = () => (ch().fields && ch().fields.length ? ch().fields : ['prop_class', 'gis_acres', 'municipality', 'owner_name', 'parcel_no']);
const TRANSFORMS = [{ v: '', l: '(none)' }, { v: 'classGroup', l: 'classGroup' }];

const labelSet = () => S().labels || {};
const zoom = () => labelSet().zoom || {};
</script>

<template>
  <template v-if="!hasStyling()">
    <div class="ac-page-head">
      <h1 class="ac-page-title">Styling</h1>
      <p class="ac-page-sub">Color scheme, theme, per-layer paint, and labels for this county.</p>
    </div>
    <div class="ac-card"><p class="ac-readonly">No styling config in the manifest yet.</p></div>
  </template>

  <ModuleFrame v-else :store="store" :flow="flow" title="Styling" sub="Color scheme, theme, per-layer paint & choropleth, and labels." edit-label="Edit styling">
    <template #banner="{ editing }">
      <div v-if="editing" class="ac-banner ac-banner-edit">
        <span>✎</span>
        <div><b>Editing a draft.</b> <b>Publish</b> makes it the live styling; the viewer reads the published config (scheme, theme, parcel colors).</div>
      </div>
      <div v-else class="ac-banner">
        <span>ⓘ</span>
        <div>
          <template v-if="state.source === 'api'">Loaded live from <code>/config</code>.</template>
          <template v-else>Showing the baked manifest fallback.</template>
          The viewer consumes the published styling (color scheme, theme, parcel paint).
        </div>
      </div>
    </template>

    <template #default="{ editing }">
      <div class="ac-card">
        <div class="ac-card-head">
          <h2 class="ac-card-title">Color scheme</h2>
          <span class="ac-card-note">{{ editing ? 'click to set default' : 'default: ' + (S().colorScheme || '—') }}</span>
        </div>
        <div class="ac-schemes">
          <component
            :is="editing ? 'button' : 'div'"
            v-for="sc in S().schemes || []"
            :key="sc.id"
            :type="editing ? 'button' : null"
            class="ac-scheme"
            :class="{ 'ac-scheme-pick': editing, 'is-active': sc.id === S().colorScheme }"
            :data-scheme-pick="editing ? sc.id : null"
            @click="editing && store.setDraft('styling.colorScheme', sc.id)"
          >
            <span v-if="sc.accent" class="ac-swatch" :style="{ background: sc.accent }" :title="sc.accent"></span>
            <span v-if="sc.interactive" class="ac-swatch" :style="{ background: sc.interactive }" :title="sc.interactive"></span>
            <span class="ac-scheme-label">{{ sc.label }}<template v-if="sc.id === S().colorScheme">{{ ' ' }}<span class="ac-xp-chars">default</span></template></span>
          </component>
        </div>
      </div>

      <div class="ac-card">
        <div class="ac-card-head"><h2 class="ac-card-title">Theme &amp; basemap</h2></div>
        <dl class="ac-grid">
          <dt>Default theme</dt>
          <dd>
            <DraftSelect v-if="editing" :store="store" path="styling.theme" :value="S().theme" :options="['light', 'dark', 'auto']" />
            <template v-else>{{ S().theme || '—' }}</template>
          </dd>
          <dt>Base layer</dt>
          <dd>
            <DraftSelect v-if="editing" :store="store" path="styling.basemap" :value="S().basemap" :options="['parcels', 'aerial']" />
            <template v-else>{{ S().basemap || '—' }}</template>
          </dd>
        </dl>
      </div>

      <div v-if="!layerIds().length" class="ac-card">
        <div class="ac-card-head"><h2 class="ac-card-title">Layer styling</h2></div>
        <p class="ac-readonly">No stylable layers in the manifest yet.</p>
      </div>
      <template v-else>
        <div class="ac-card">
          <div class="ac-card-head">
            <h2 class="ac-card-title">Layer styling</h2>
            <span class="ac-card-note">{{ GEOM_NOTE[geomType()] }}</span>
          </div>
          <dl class="ac-grid">
            <dt>Layer</dt>
            <dd>
              <select class="ac-input ac-input-sm" data-style-layer @change="picked = $event.target.value">
                <option v-for="id in layerIds()" :key="id" :value="id" :selected="id === selId()">{{ layers()[id].label || id }}</option>
              </select>
              {{ ' ' }}<span class="ac-card-note">{{ geomType() }}</span>
            </dd>
            <template v-for="[label, rel, kind, unit, note] in ROWS[geomType()]" :key="selId() + rel">
              <dt>{{ label }}</dt>
              <dd>
                <ColorField v-if="kind === 'color'" :store="store" :path="lp() + '.' + rel" :value="rowValue(rel)" :editing="editing" />
                <template v-else-if="kind === 'dash'">
                  <DraftSelect v-if="editing" :store="store" :path="lp() + '.' + rel" :value="rowValue(rel) || 'solid'" :options="['solid', 'dashed', 'dotted']" />
                  <template v-else>{{ rowValue(rel) || 'solid' }}</template>
                </template>
                <template v-else>
                  <DraftField v-if="editing" :store="store" class="ac-input-sm" type="num" input-type="number" style="max-width:84px" :path="lp() + '.' + rel" :value="rowValue(rel)" />
                  <template v-else>{{ shown(rowValue(rel), unit) }}</template>
                </template>
                <template v-if="note">{{ ' ' }}<span class="ac-card-note">{{ note }}</span></template>
              </dd>
            </template>
          </dl>
          <p v-if="geomType() === 'line'" class="ac-readonly" style="margin-top:8px">Width-by-type needs the layer’s tiles to expose a class attribute (DB-side); this layer’s tiles carry only name/feature_type today.</p>
        </div>

        <template v-if="geomType() === 'polygon'">
          <div class="ac-card">
            <div class="ac-card-head">
              <h2 class="ac-card-title">Choropleth</h2>
              <span class="ac-card-note">{{ editing ? 'color ' + lyrLabel() + ' by an attribute' : (ch().enabled ? 'on · ' + (ch().attribute || '—') : 'off') }}</span>
            </div>
            <dl v-if="editing" class="ac-grid">
              <dt>Enabled</dt>
              <dd><DraftField :store="store" type="bool" :path="cp() + '.enabled'" :value="ch().enabled" /> <span class="ac-card-note">color {{ lyrLabel() }} by the attribute below</span></dd>
              <dt>Attribute</dt>
              <dd><DraftSelect :store="store" :path="cp() + '.attribute'" :value="ch().attribute" :options="attrOptions()" /></dd>
              <dt>Mode</dt>
              <dd><DraftSelect :store="store" :path="cp() + '.mode'" :value="ch().mode" :options="['categorical', 'graduated']" /></dd>
              <dt>Transform</dt>
              <dd><DraftSelect :store="store" :path="cp() + '.transform'" :value="ch().transform" :options="TRANSFORMS" /> <span class="ac-card-note">classGroup → first digit of prop_class</span></dd>
              <dt>Fallback</dt>
              <dd><ColorField :store="store" :path="cp() + '.fallback'" :value="ch().fallback" editing /></dd>
              <dt>Opacity</dt>
              <dd>
                <DraftField :store="store" class="ac-input-sm" type="num" input-type="number" style="max-width:84px" :path="cp() + '.opacity'" :value="ch().opacity" />
                <span class="ac-card-note">fill opacity of the wash (e.g. 0.16 = subtle)</span>
              </dd>
            </dl>
            <dl v-else class="ac-grid">
              <dt>Enabled</dt><dd>{{ ch().enabled ? 'Yes' : 'No' }}</dd>
              <template v-if="ch().enabled">
                <dt>Attribute</dt><dd><code>{{ ch().attribute || '—' }}</code></dd>
                <dt>Mode</dt><dd>{{ ch().mode || '—' }}{{ ch().transform === 'classGroup' ? ' · classGroup' : '' }}</dd>
                <dt>Fallback</dt><dd><ColorField :store="store" :path="cp() + '.fallback'" :value="ch().fallback" /></dd>
                <dt>Opacity</dt><dd>{{ ch().opacity != null ? ch().opacity : '—' }}</dd>
              </template>
            </dl>
            <p v-if="!editing && !ch().enabled" class="ac-readonly">Off — {{ lyrLabel() }} uses the solid paint above. Edit to color by an attribute.</p>
          </div>

          <!-- Only the ramp for the current mode shows. -->
          <div v-if="editing || ch().enabled" class="ac-card">
            <template v-if="ch().mode === 'graduated'">
              <div class="ac-card-head">
                <h2 class="ac-card-title">Color stops</h2>
                <span class="ac-card-note">≥ min → color (step)</span>
              </div>
              <table class="ac-table">
                <thead><tr><th>Color</th><th>Min</th><th>Label</th><th v-if="editing"></th></tr></thead>
                <tbody>
                  <tr v-for="(st, i) in ch().stops || []" :key="i">
                    <td><ColorField :store="store" :path="`${cp()}.stops.${i}.color`" :value="st.color" :editing="editing" /></td>
                    <template v-if="editing">
                      <td><DraftField :store="store" class="ac-input-sm" type="num" input-type="number" style="max-width:84px" :path="`${cp()}.stops.${i}.min`" :value="st.min" /></td>
                      <td><DraftField :store="store" class="ac-input-sm" :path="`${cp()}.stops.${i}.label`" :value="st.label" :placeholder="'≥ ' + (st.min != null ? st.min : '')" /></td>
                      <td><button type="button" class="ac-btn ac-btn-sm" :data-remove="cp() + '.stops'" :data-index="i" @click="store.removeRow(cp() + '.stops', i)">Remove</button></td>
                    </template>
                    <template v-else>
                      <td>{{ st.min != null ? st.min : '—' }}</td>
                      <td>{{ st.label || '—' }}</td>
                    </template>
                  </tr>
                  <tr v-if="!(ch().stops || []).length">
                    <td :colspan="editing ? 4 : 3" class="ac-readonly">No stops yet{{ editing ? ' — add one below.' : '.' }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="editing" class="ac-add-row">
                <button type="button" class="ac-btn ac-btn-sm" :data-add="cp() + '.stops'" @click="store.addRow(cp() + '.stops')">+ Add stop</button>
              </div>
            </template>
            <template v-else>
              <div class="ac-card-head">
                <h2 class="ac-card-title">Categories</h2>
                <span class="ac-card-note">value → color (match)</span>
              </div>
              <table class="ac-table">
                <thead><tr><th>Color</th><th>Value</th><th>Label</th><th v-if="editing"></th></tr></thead>
                <tbody>
                  <tr v-for="(c, i) in ch().categories || []" :key="i">
                    <td><ColorField :store="store" :path="`${cp()}.categories.${i}.color`" :value="c.color" :editing="editing" /></td>
                    <template v-if="editing">
                      <td><DraftField :store="store" class="ac-input-sm" :path="`${cp()}.categories.${i}.value`" :value="c.value" placeholder="1" /></td>
                      <td><DraftField :store="store" class="ac-input-sm" :path="`${cp()}.categories.${i}.label`" :value="c.label" placeholder="Residential" /></td>
                      <td><button type="button" class="ac-btn ac-btn-sm" :data-remove="cp() + '.categories'" :data-index="i" @click="store.removeRow(cp() + '.categories', i)">Remove</button></td>
                    </template>
                    <template v-else>
                      <td><code>{{ c.value || '—' }}</code></td>
                      <td>{{ c.label || '—' }}</td>
                    </template>
                  </tr>
                  <tr v-if="!(ch().categories || []).length">
                    <td :colspan="editing ? 4 : 3" class="ac-readonly">No categories yet{{ editing ? ' — add one below.' : '.' }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="editing" class="ac-add-row">
                <button type="button" class="ac-btn ac-btn-sm" :data-add="cp() + '.categories'" @click="store.addRow(cp() + '.categories')">+ Add category</button>
              </div>
            </template>
          </div>
        </template>

        <div class="ac-card">
          <div class="ac-card-head">
            <h2 class="ac-card-title">Labels</h2>
            <span class="ac-card-note">text {{ geomType() === 'line' ? 'along the line' : 'at each feature' }}</span>
          </div>
          <p v-if="!layerFields().length" class="ac-readonly">This layer’s tiles expose no label-able attributes.</p>
          <dl v-else-if="editing" class="ac-grid">
            <dt>Show labels</dt><dd><DraftField :store="store" type="bool" :path="lp() + '.labels.enabled'" :value="sub('labels').enabled" /></dd>
            <dt>Label field</dt>
            <dd><DraftSelect :store="store" :path="lp() + '.labels.field'" :value="sub('labels').field" :options="[{ v: '', l: '(none)' }, ...layerFields()]" /></dd>
            <template v-for="[label, key] in [['Text size', 'size'], ['Min zoom', 'minZoom'], ['Halo width', 'haloWidth']]" :key="key">
              <dt>{{ label }}</dt>
              <dd><DraftField :store="store" class="ac-input-sm" type="num" input-type="number" style="max-width:84px" :path="lp() + '.labels.' + key" :value="sub('labels')[key]" /></dd>
            </template>
            <template v-for="[label, rel] in [['Light — text', 'light.color'], ['Light — halo', 'light.haloColor'], ['Dark — text', 'dark.color'], ['Dark — halo', 'dark.haloColor']]" :key="rel">
              <dt>{{ label }}</dt>
              <dd><ColorField :store="store" :path="lp() + '.labels.' + rel" :value="rowValue('labels.' + rel)" editing /></dd>
            </template>
          </dl>
          <dl v-else class="ac-grid">
            <dt>Labels</dt><dd>{{ sub('labels').enabled ? 'On' : 'Off' }}</dd>
            <template v-if="sub('labels').enabled">
              <dt>Field</dt><dd><code>{{ sub('labels').field || '—' }}</code></dd>
              <dt>Size · min zoom</dt><dd>{{ sub('labels').size || '—' }}px · z{{ sub('labels').minZoom || 0 }}+</dd>
            </template>
          </dl>
        </div>
      </template>

      <div class="ac-card">
        <div class="ac-card-head"><h2 class="ac-card-title">Parcel labels</h2></div>
        <dl class="ac-grid">
          <dt>Default field</dt>
          <dd>
            <DraftSelect v-if="editing" :store="store" path="styling.labels.defaultField" :value="labelSet().defaultField" :options="labelSet().fields || []" />
            <template v-else>{{ labelSet().defaultField || '—' }}</template>
          </dd>
          <dt>Default size</dt>
          <dd>
            <DraftSelect v-if="editing" :store="store" path="styling.labels.defaultSize" :value="labelSet().defaultSize" :options="labelSet().sizes || ['small', 'medium', 'large']" />
            <template v-else>{{ labelSet().defaultSize || '—' }}</template>
          </dd>
          <dt>Zoom — large / small</dt>
          <dd>
            <template v-if="editing">
              <DraftField :store="store" class="ac-input-sm" type="num" input-type="number" path="styling.labels.zoom.largeParcels" :value="zoom().largeParcels || ''" />
              /
              <DraftField :store="store" class="ac-input-sm" type="num" input-type="number" path="styling.labels.zoom.smallParcels" :value="zoom().smallParcels || ''" />
            </template>
            <template v-else>large {{ zoom().largeParcels || '—' }}+, small {{ zoom().smallParcels || '—' }}+</template>
          </dd>
        </dl>
      </div>
    </template>
  </ModuleFrame>
</template>
