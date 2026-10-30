<!-- County Configuration (DIC-458 view, DIC-464/466 editing; a Vue module since DIC-2389,
     was admin.js renderCounty): identity, map defaults, endpoints, integrations, the
     parcel-number format (DIC-501: the PIN's segments, read by the Tax Description
     explainer), and the code → name reference lookups (view only). -->
<script setup>
import { ref } from 'vue';
import DraftField from '../DraftField.vue';
import { useEditFlow } from '../edit-flow.js';
import ModuleFrame from '../ModuleFrame.vue';

const props = defineProps({ store: { type: Object, required: true } });
const state = props.store.state;
const flow = useEditFlow(props.store);

// What's shown, read at render time. The draft changes in place, so reading state.rev
// here is what redraws an added or removed row (a computed would hand back the same
// object and redraw nothing).
const C = () => (state.rev, props.store.current());
const at = (obj, key) => (obj && obj[key]) || {};

// The simple cards, each field as [label, path, type].
const CARDS = [
  { title: 'Identity', fields: [['Name', 'name', 'str'], ['State', 'state', 'str'], ['Data request form', 'forms.dataRequest', 'str']] },
  { title: 'Map defaults', fields: [['Center [lng, lat]', 'map.center', 'json'], ['Default zoom', 'map.zoom', 'num'], ['Extent', 'map.extent', 'json']] },
  { title: 'Endpoints', fields: [['Map Buddy AI', 'endpoints.mapBuddy', 'str']] },
  {
    title: 'Integrations',
    note: 'Google Maps Embed key powers in-panel Street View. Restrict it by HTTP referrer to this domain. Empty → Street View opens in a new tab.',
    fields: [['Google Maps Embed key', 'integrations.googleMapsEmbedKey', 'str']],
  },
];
const PIN = [['Separator', 'parcelNumber.separator', 'str'], ['Example PIN', 'parcelNumber.example', 'str'], ['Intro line', 'parcelNumber.intro', 'str']];

const valueAt = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), C());
const display = (val, type) => {
  if (val == null || val === '') return null;   // shown as —
  return type === 'json' ? JSON.stringify(val) : String(val);
};

const segments = () => at(C(), 'parcelNumber').segments || [];
const LOOKUPS = [['propClass', 'Property classes'], ['schoolDist', 'School districts']];
const lookup = (key) => at(at(C(), 'labels'), key);
const shownLookup = ref(null);   // which lookup's table is open
const toggleLookup = (key) => { shownLookup.value = shownLookup.value === key ? null : key; };
const lookupRows = () => {
  const m = shownLookup.value ? lookup(shownLookup.value) : {};
  return Object.keys(m).sort().map((k) => [k, m[k]]);
};
</script>

<template>
  <ModuleFrame :store="store" :flow="flow" title="County Configuration" sub="Identity, map defaults, endpoints, and reference lookups for this county." edit-label="Edit configuration">
    <template #banner="{ editing }">
      <div class="ac-banner" :class="{ 'ac-banner-edit': editing }">
        <span>{{ editing ? '✎' : 'ⓘ' }}</span>
        <div>
          <template v-if="editing"><b>Editing a draft.</b> <b>Save draft</b> stores your changes; <b>Publish</b> makes the draft the live config as a new version. </template>
          <template v-if="state.source === 'api'">Loaded live from the runtime <code>/config</code> API (<b>DIC-465</b>).</template>
          <template v-else>Runtime <code>/config</code> API (<b>DIC-465</b>) not reachable — showing the baked <code>county-config.js</code> fallback.</template>
          <template v-if="!editing"> Editing writes to the config store (<b>DIC-464</b>); real auth is <b>DIC-463</b>.</template>
        </div>
      </div>
    </template>

    <template #default="{ editing }">
      <div v-for="c in CARDS" :key="c.title" class="ac-card">
        <div class="ac-card-head">
          <h2 class="ac-card-title">{{ c.title }}</h2>
          <span v-if="c.note" class="ac-card-note">{{ c.note }}</span>
        </div>
        <dl class="ac-grid">
          <template v-for="[label, path, type] in c.fields" :key="path">
            <dt>{{ label }}</dt>
            <dd>
              <DraftField v-if="editing" :store="store" :path="path" :type="type" :value="valueAt(path)" />
              <template v-else-if="display(valueAt(path), type) == null">—</template>
              <code v-else-if="type === 'json'">{{ display(valueAt(path), type) }}</code>
              <template v-else>{{ display(valueAt(path), type) }}</template>
            </dd>
          </template>
        </dl>
      </div>

      <div class="ac-card">
        <div class="ac-card-head">
          <h2 class="ac-card-title">Parcel number format</h2>
          <span class="ac-card-note">how this county’s PIN breaks down · used by the Tax Description explainer (DIC-501)</span>
        </div>
        <dl class="ac-grid">
          <template v-for="[label, path, type] in PIN" :key="path">
            <dt>{{ label }}</dt>
            <dd>
              <DraftField v-if="editing" :store="store" :path="path" :type="type" :value="valueAt(path)" />
              <template v-else>{{ display(valueAt(path), type) ?? '—' }}</template>
            </dd>
          </template>
        </dl>
        <table class="ac-table">
          <thead><tr><th style="width:32px">#</th><th>Segment</th><th>Meaning</th><th v-if="editing"></th></tr></thead>
          <tbody>
            <tr v-for="(s, i) in segments()" :key="i">
              <td class="ac-pn-ord">{{ i + 1 }}</td>
              <template v-if="editing">
                <td><DraftField :store="store" class="ac-input-sm" :path="`parcelNumber.segments.${i}.name`" :value="s.name || ''" /></td>
                <td><DraftField :store="store" :path="`parcelNumber.segments.${i}.description`" :value="s.description || ''" /></td>
                <td><button type="button" class="ac-btn ac-btn-sm" data-remove="parcelNumber.segments" :data-index="i" @click="store.removeRow('parcelNumber.segments', i)">Remove</button></td>
              </template>
              <template v-else>
                <td>{{ s.name || '—' }}</td>
                <td>{{ s.description || '—' }}</td>
              </template>
            </tr>
            <tr v-if="!segments().length">
              <td :colspan="editing ? 4 : 3" class="ac-readonly">No segments defined{{ editing ? ' — add one below.' : '.' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="editing" class="ac-add-row">
          <button type="button" class="ac-btn ac-btn-sm" data-add="parcelNumber.segments" @click="store.addRow('parcelNumber.segments')">+ Add segment</button>
        </div>
      </div>

      <div class="ac-card">
        <div class="ac-card-head">
          <h2 class="ac-card-title">Reference lookups</h2>
          <span class="ac-card-note">code → name maps{{ editing ? ' · edit via API for now' : ' shared by the popup & explainers' }}</span>
        </div>
        <dl class="ac-grid">
          <template v-for="[key, label] in LOOKUPS" :key="key">
            <dt>{{ label }}</dt>
            <dd>
              {{ Object.keys(lookup(key)).length }} codes
              <button type="button" class="ac-lookup-toggle" :data-lookup="key" :aria-expanded="String(shownLookup === key)" @click="toggleLookup(key)">{{ shownLookup === key ? 'Hide' : 'View' }}</button>
            </dd>
          </template>
        </dl>
        <div id="ac-lookup-out">
          <table v-if="shownLookup" class="ac-table">
            <thead><tr><th>Code</th><th>Name</th></tr></thead>
            <tbody><tr v-for="[k, v] in lookupRows()" :key="k"><td>{{ k }}</td><td>{{ v }}</td></tr></tbody>
          </table>
        </div>
      </div>
    </template>
  </ModuleFrame>
</template>
