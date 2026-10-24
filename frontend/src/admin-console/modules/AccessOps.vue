<!-- Access & Ops (DIC-462; a Vue module since DIC-2389, was admin.js renderAccess): the
     `access` block (model, assessment visibility, report inbox, rate limit) and the
     data-request form URL, editable through the shared draft → publish flow. The Services
     card stays read-only: those endpoints belong to other modules (tile server → Data &
     Layers, Map Buddy → County) or are runtime.

     Fields keep admin.js's data-path / data-type attributes. The draft is a plain object
     (store.js), so typing changes it in place without redrawing the form. -->
<script setup>
import { computed } from 'vue';
import { useEditFlow } from '../edit-flow.js';
import ModuleFrame from '../ModuleFrame.vue';

const props = defineProps({ store: { type: Object, required: true } });
const state = props.store.state;
const flow = useEditFlow(props.store);

const C = computed(() => props.store.current());
const A = computed(() => C.value.access || {});
const forms = computed(() => C.value.forms || {});
const tileUrl = computed(() => ((C.value.layers || {}).tileServer || {}).url || '/tiles');
const mapBuddy = computed(() => (C.value.endpoints || {}).mapBuddy || '—');

const PLANNED = [
  'Public-vs-staff gating toggles per county',
  'Embeds + shareable links (DIC-399 / DIC-340)',
  'Data-error report triage dashboard (DIC-391)',
  'Usage / analytics + change audit log',
  'One-click redeploy trigger (e.g. Map Buddy, DIC-452)',
];

const setText = (path, e) => props.store.setDraft(path, e.target.value);
const setBool = (path, e) => props.store.setDraft(path, e.target.checked);
</script>

<template>
  <ModuleFrame :store="store" :flow="flow" title="Access & Ops" sub="Who can see what, how it’s shared, and how staff watch it." edit-label="Edit access">
    <template #banner="{ editing }">
      <div v-if="editing" class="ac-banner ac-banner-edit">
        <span>✎</span>
        <div>
          <b>Editing a draft.</b>
          Set the access model, assessment-data visibility, report inbox, and rate-limit flag, then <b>Publish</b>.
          Service endpoints below are owned by their own modules and stay read-only here.
        </div>
      </div>
      <div v-else class="ac-banner">
        <span>ⓘ</span>
        <div>
          <template v-if="state.source === 'api'">Loaded live from <code>/config</code>.</template>
          <template v-else>Showing the baked manifest fallback.</template>
          Embeds, usage dashboards, and a deploy trigger are the planned DIC-462 build.
        </div>
      </div>
    </template>

    <template #default="{ editing }">
      <div class="ac-card">
        <div class="ac-card-head"><h2 class="ac-card-title">Access</h2></div>
        <dl class="ac-grid">
          <dt>Access model</dt>
          <dd>
            <input v-if="editing" class="ac-input" data-path="access.model" data-type="str" :value="A.model ?? ''" placeholder="e.g. Public — no sign-in" @input="setText('access.model', $event)">
            <template v-else>{{ A.model || '—' }}</template>
          </dd>
          <dt>Assessment data</dt>
          <dd>
            <template v-if="editing">
              <input type="checkbox" data-path="access.assessmentDataPublic" data-type="bool" :checked="!!A.assessmentDataPublic" @change="setBool('access.assessmentDataPublic', $event)">
              <span class="ac-card-note">public</span>
            </template>
            <template v-else>{{ A.assessmentDataPublic ? 'Public' : 'Gated' }}</template>
          </dd>
          <dt>Data request form</dt>
          <dd>
            <input v-if="editing" class="ac-input" data-path="forms.dataRequest" data-type="str" :value="forms.dataRequest ?? ''" placeholder="https://…" @input="setText('forms.dataRequest', $event)">
            <code v-else-if="forms.dataRequest">{{ forms.dataRequest }}</code>
            <template v-else>—</template>
          </dd>
          <dt>Error reports go to</dt>
          <dd>
            <input v-if="editing" class="ac-input" data-path="access.reportTo" data-type="str" :value="A.reportTo ?? ''" placeholder="gis@county.gov" @input="setText('access.reportTo', $event)">
            <code v-else>{{ A.reportTo || '—' }}</code>
          </dd>
          <dt>Rate limited</dt>
          <dd>
            <template v-if="editing">
              <input type="checkbox" data-path="access.rateLimited" data-type="bool" :checked="!!A.rateLimited" @change="setBool('access.rateLimited', $event)">
              <span class="ac-card-note">throttle public endpoints</span>
            </template>
            <template v-else>{{ A.rateLimited ? 'Yes' : 'No' }}</template>
          </dd>
        </dl>
      </div>

      <div class="ac-card">
        <div class="ac-card-head">
          <h2 class="ac-card-title">Services</h2>
          <span class="ac-card-note">read-only · owned by other modules</span>
        </div>
        <dl class="ac-grid">
          <dt>Parcel API</dt><dd><code>{{ store.apiBase() }}</code></dd>
          <dt>Tile server</dt><dd><code>{{ tileUrl }}</code></dd>
          <dt>Map Buddy AI</dt><dd><code>{{ mapBuddy }}</code></dd>
        </dl>
      </div>

      <div class="ac-card">
        <div class="ac-card-head"><h2 class="ac-card-title">Planned (DIC-462)</h2></div>
        <ul class="ac-plan"><li v-for="p in PLANNED" :key="p">{{ p }}</li></ul>
      </div>
    </template>
  </ModuleFrame>
</template>
