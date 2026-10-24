<!-- Data & Layers (DIC-461; a Vue module since DIC-2389, was admin.js renderData): the
     tile server, the PostGIS (vector) layers it serves, which are the editable focus,
     the legacy WMS / raster overlays (read-only, being phased out), and the data
     sources behind them. "Add a layer" (DIC-502) picks a layer the tile server can
     serve and adds it to the draft, entering edit mode if needed. -->
<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import * as admin from '../../shared/admin.js';
import {
  availableLayers, defaultPaint, discoveryError, loadDiscovered, optionText, overlayFor, titleize,
} from '../discovery.js';
import DraftField from '../DraftField.vue';
import { useEditFlow } from '../edit-flow.js';
import ModuleFrame from '../ModuleFrame.vue';

const props = defineProps({
  store: { type: Object, required: true },
  // Injected so Vitest can fake the API.
  discover: {
    type: Function,
    default: (store) => loadDiscovered({ fetch: (...a) => globalThis.fetch(...a), apiBase: admin.apiBase, auth: store.auth }),
  },
});
const state = props.store.state;
const flow = useEditFlow(props.store);

// Read at render time (state.rev: the draft changes in place, see CountyConfig.vue).
const C = () => (state.rev, props.store.current());
const L = () => C().layers || {};
const ts = () => L().tileServer || {};
const isPg = (o) => ['vector', 'postgis', 'mvt'].includes(String((o && o.type) || '').toLowerCase());
// Each overlay with its index in layers.overlays, so edits target the right slot
// whichever group it shows in.
const overlays = () => (L().overlays || []).map((o, i) => ({ o, i }));
const pgRows = () => overlays().filter((r) => isPg(r.o));
const extRows = () => overlays().filter((r) => !isPg(r.o));
const sources = () => L().dataSources || [];
const zoomText = (o) => (o.minZoom ? 'z' + o.minZoom + '+' : 'all');

// ── Add a layer ───────────────────────────────────────────────────────────────
const discovered = ref(null);   // null while loading, then { layers } or { error }
const picked = ref('');
async function refresh() {
  discovered.value = null;
  picked.value = '';
  discovered.value = await props.discover(props.store);
}
onMounted(refresh);
// Signing in or out changes what discovery may answer.
watch(() => props.store.auth && props.store.auth.has(), refresh);

const available = () => (discovered.value && discovered.value.layers ? availableLayers(discovered.value.layers, C()) : []);
const bySource = computed(() => Object.fromEntries(((discovered.value && discovered.value.layers) || []).map((d) => [d.source, d])));
const pickedLayer = () => (picked.value && bySource.value[picked.value]) || null;
// The pulldown's single placeholder option while there's nothing to pick.
const pickStatus = () => {
  const d = discovered.value;
  if (!d) return 'Loading available layers…';
  if (d.error === 'sign-in') return 'Discovery needs a staff sign-in';
  if (d.error) return 'Discovery unavailable';
  if (!available().length) return 'All available layers added';
  return null;
};

function addPicked() {
  const d = pickedLayer();
  if (!d) { flow.say(false, 'Pick a layer to add first.'); return; }
  if (!state.editing) props.store.ensureDraft();
  const rows = props.store.rowsAt('layers.overlays');
  if (!rows.some((o) => o.source === d.source)) {
    rows.push(overlayFor(d));
    // Seed a default per-layer style (DIC-460) so the viewer can paint it.
    props.store.setDraft('styling.layers.' + d.id, { label: titleize(d.id), paint: defaultPaint(d.geomType || 'polygon') });
  }
  picked.value = '';
  flow.say(true, 'Added “' + titleize(d.id) + '”. Publish to make it live in the viewer.');
}
</script>

<template>
  <ModuleFrame :store="store" :flow="flow" title="Data & Layers" sub="PostGIS layers, the tile server, and the data sources behind them." edit-label="Edit layers">
    <template #banner="{ editing }">
      <div v-if="editing" class="ac-banner ac-banner-edit">
        <span>✎</span>
        <div>
          <b>Editing a draft.</b>
          Edit the PostGIS (vector) layers, tile server, and data sources, then <b>Publish</b> to make it the live layer config.
          Legacy WMS/raster overlays are read-only — they’re being phased out.
        </div>
      </div>
      <div v-else class="ac-banner">
        <span>ⓘ</span>
        <div>
          <template v-if="state.source === 'api'">Loaded live from <code>/config</code>.</template>
          <template v-else>Showing the baked manifest fallback.</template>
          PostGIS (vector) layers served via the tile server are the editable focus; WMS/raster overlays are being phased out.
        </div>
      </div>
    </template>

    <template #default="{ editing }">
      <div class="ac-card">
        <div class="ac-card-head">
          <h2 class="ac-card-title">Tile server</h2>
          <span class="ac-card-note">serves the PostGIS vector tiles</span>
        </div>
        <dl class="ac-grid">
          <dt>Provider</dt>
          <dd>
            <DraftField v-if="editing" :store="store" class="ac-input-sm" path="layers.tileServer.provider" :value="ts().provider" placeholder="Martin" />
            <template v-else>{{ ts().provider || '—' }}</template>
          </dd>
          <dt>URL</dt>
          <dd>
            <DraftField v-if="editing" :store="store" class="ac-input-sm" path="layers.tileServer.url" :value="ts().url" placeholder="/tiles" />
            <code v-else>{{ ts().url || '—' }}</code>
          </dd>
        </dl>
      </div>

      <div class="ac-card">
        <div class="ac-card-head">
          <h2 class="ac-card-title">PostGIS layers</h2>
          <span class="ac-card-note">{{ pgRows().length }} vector layer(s)</span>
        </div>
        <table class="ac-table">
          <thead><tr><th>Layer</th><th>Source</th><th>Min zoom</th><th>Default on</th><th v-if="editing"></th></tr></thead>
          <tbody>
            <tr v-for="r in pgRows()" :key="r.i">
              <template v-if="editing">
                <td><DraftField :store="store" class="ac-input-sm" :path="`layers.overlays.${r.i}.label`" :value="r.o.label" /></td>
                <td><DraftField :store="store" class="ac-input-sm" :path="`layers.overlays.${r.i}.source`" :value="r.o.source" placeholder="PostGIS table / Martin source" /></td>
                <td><DraftField :store="store" class="ac-input-sm" type="num" :path="`layers.overlays.${r.i}.minZoom`" :value="r.o.minZoom" input-type="number" style="max-width:78px" /></td>
                <td style="text-align:center"><DraftField :store="store" type="bool" :path="`layers.overlays.${r.i}.default`" :value="r.o.default" /></td>
                <td><button type="button" class="ac-btn ac-btn-sm" data-remove="layers.overlays" :data-index="r.i" @click="store.removeRow('layers.overlays', r.i)">Remove</button></td>
              </template>
              <template v-else>
                <td>{{ r.o.label }}</td>
                <td><code>{{ r.o.source || '—' }}</code></td>
                <td>{{ zoomText(r.o) }}</td>
                <td>{{ r.o.default ? 'on' : '' }}</td>
              </template>
            </tr>
            <tr v-if="!pgRows().length">
              <td :colspan="editing ? 5 : 4" class="ac-readonly">No PostGIS layers yet{{ editing ? ' — add one below.' : '.' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="editing" class="ac-add-row">
          <button type="button" class="ac-btn ac-btn-sm" data-add="layers.overlays" @click="store.addRow('layers.overlays')">+ Add PostGIS layer</button>
        </div>
      </div>

      <div class="ac-card">
        <div class="ac-card-head">
          <h2 class="ac-card-title">Add a layer</h2>
          <span class="ac-card-note">PostGIS layers the tile server can serve (DIC-502)</span>
        </div>
        <p class="ac-readonly" style="margin:0 0 10px">Pick a spatial layer already in PostGIS to add it as a viewer overlay — no developer, no DB migration.</p>
        <div class="ac-pick-row">
          <select id="ac-pg-pick" v-model="picked" class="ac-input ac-input-sm" data-pg-pick aria-label="PostGIS layer" :disabled="pickStatus() != null">
            <option v-if="pickStatus() != null" value="">{{ pickStatus() }}</option>
            <template v-else>
              <option value="">Select a layer to add…</option>
              <option v-for="d in available()" :key="d.source" :value="d.source">{{ optionText(d) }}</option>
            </template>
          </select>
          <button type="button" class="ac-btn ac-btn-sm ac-btn-primary" data-add-pick @click="addPicked">Add layer</button>
        </div>
        <div id="ac-pg-pick-meta" style="margin-top:10px">
          <p v-if="discovered && discovered.error" class="ac-readonly">{{ discoveryError(discovered.error) }}</p>
          <dl v-else-if="pickedLayer()" class="ac-grid">
            <dt>Geometry</dt><dd>{{ pickedLayer().geomType || '—' }}</dd>
            <dt>Features</dt><dd>{{ pickedLayer().rowCount != null ? Number(pickedLayer().rowCount).toLocaleString() : '—' }}</dd>
            <dt>PostGIS source</dt><dd><code>{{ pickedLayer().dbSource || pickedLayer().source }}</code></dd>
            <dt>Tile source</dt><dd><code>{{ pickedLayer().source }}</code></dd>
          </dl>
        </div>
      </div>

      <div v-if="extRows().length" class="ac-card">
        <div class="ac-card-head">
          <h2 class="ac-card-title">External overlays</h2>
          <span class="ac-card-note">WMS / raster — being phased out</span>
        </div>
        <table class="ac-table">
          <thead><tr><th>Overlay</th><th>Type</th><th>Source</th><th>Min zoom</th></tr></thead>
          <tbody>
            <tr v-for="r in extRows()" :key="r.i"><td>{{ r.o.label }}</td><td>{{ r.o.type }}</td><td>{{ r.o.source }}</td><td>{{ zoomText(r.o) }}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="ac-card">
        <div class="ac-card-head">
          <h2 class="ac-card-title">Data sources</h2>
          <span class="ac-card-note">PostGIS tables</span>
        </div>
        <table class="ac-table">
          <thead><tr><th>Dataset</th><th>Source</th><th v-if="editing"></th></tr></thead>
          <tbody>
            <tr v-for="(d, i) in sources()" :key="i">
              <template v-if="editing">
                <td><DraftField :store="store" class="ac-input-sm" :path="`layers.dataSources.${i}.label`" :value="d.label" /></td>
                <td><DraftField :store="store" class="ac-input-sm" :path="`layers.dataSources.${i}.source`" :value="d.source" placeholder="schema.table" /></td>
                <td><button type="button" class="ac-btn ac-btn-sm" data-remove="layers.dataSources" :data-index="i" @click="store.removeRow('layers.dataSources', i)">Remove</button></td>
              </template>
              <template v-else>
                <td>{{ d.label }}</td>
                <td><code>{{ d.source }}</code></td>
              </template>
            </tr>
            <tr v-if="!sources().length">
              <td :colspan="editing ? 3 : 2" class="ac-readonly">No data sources defined.</td>
            </tr>
          </tbody>
        </table>
        <div v-if="editing" class="ac-add-row">
          <button type="button" class="ac-btn ac-btn-sm" data-add="layers.dataSources" @click="store.addRow('layers.dataSources')">+ Add data source</button>
        </div>
        <p v-else class="ac-readonly" style="margin-top:8px">Self-serve ingestion (upload → field-map → validate → publish, versioned) is the planned DIC-461 loader.</p>
      </div>
    </template>
  </ModuleFrame>
</template>
