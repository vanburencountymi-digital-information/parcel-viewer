<!-- Intelligence (DIC-459; a Vue module since DIC-2389, was admin.js renderIntelligence):
     the explainer plugins from the Map Buddy service, read-only. Each card shows a
     plugin's id, audience, model and how to call it, with its system prompt and each
     injected context block behind a toggle. -->
<script setup>
import { onMounted, reactive, ref } from 'vue';
import * as admin from '../../shared/admin.js';
import { loadExplainers } from '../explainers.js';

const props = defineProps({
  store: { type: Object, required: true },
  // Injected so Vitest can fake the service.
  load: { type: Function, default: () => loadExplainers({ fetch: (...a) => globalThis.fetch(...a), base: admin.mapBuddyBase }) },
});
const result = ref(null);       // null while loading, then { explainers } or { error }
const open = reactive({});      // which toggles are open, by their <pre>'s id

onMounted(async () => { result.value = await props.load(); });

const toggle = (id) => { open[id] = !open[id]; };
const blockId = (x, i) => 'blk-' + x.id + '-' + i;
const promptId = (x) => 'sp-' + x.id;
</script>

<template>
  <div class="ac-page-head">
    <h1 class="ac-page-title">Intelligence — Explainer Plugins</h1>
    <p class="ac-page-sub">Each explainer is a callable plugin with its own LLM context — system prompt, injected reference material, and model. Read-only for now; editing lands with the writable store.</p>
  </div>
  <div class="ac-banner">
    <span>ⓘ</span>
    <div>Live config from the Map Buddy service. Editing &amp; publish need the writable store (<b>DIC-464</b>) + auth (<b>DIC-463</b>).</div>
  </div>
  <div id="ac-xp-list">
    <p v-if="!result" class="ac-readonly">Loading explainer plugins…</p>
    <div v-else-if="result.error" class="ac-card">
      <p class="ac-readonly">Couldn’t reach the Map Buddy service ({{ result.error }}). The explainer plugins live there; this view needs that service running (it goes live with the next Map Buddy redeploy, DIC-452).</p>
    </div>
    <p v-else-if="!result.explainers.length" class="ac-readonly">No explainer plugins registered.</p>
    <template v-else>
      <div v-for="x in result.explainers" :key="x.id" class="ac-card ac-xp-card" :data-xp-id="x.id">
        <div class="ac-card-head">
          <h2 class="ac-card-title">{{ x.label }}</h2>
          <span class="ac-xp-model">{{ x.model || '—' }}</span>
        </div>
        <dl class="ac-grid">
          <dt>Plugin id</dt><dd><code>{{ x.id }}</code></dd>
          <dt>Audience</dt><dd>{{ x.audience || '—' }}</dd>
          <dt>Callable</dt><dd><code>{{ x.callable_via || '—' }}</code></dd>
        </dl>
        <div class="ac-xp-section">
          <button type="button" class="ac-collapse" :data-collapse="promptId(x)" :aria-controls="promptId(x)" :aria-expanded="String(!!open[promptId(x)])" @click="toggle(promptId(x))">
            <span class="ac-arrow">{{ open[promptId(x)] ? '▾' : '▸' }}</span> System prompt
            <span class="ac-xp-chars">{{ (x.system_prompt || '').length }} chars</span>
          </button>
          <pre :id="promptId(x)" class="ac-xp-pre" :hidden="!open[promptId(x)]">{{ x.system_prompt || '' }}</pre>
        </div>
        <div v-if="x.context_blocks && x.context_blocks.length" class="ac-xp-section">
          <div class="ac-xp-blocks-title">Injected context ({{ x.context_blocks.length }})</div>
          <div v-for="(b, i) in x.context_blocks" :key="i" class="ac-xp-block">
            <button type="button" class="ac-collapse" :data-collapse="blockId(x, i)" :aria-controls="blockId(x, i)" :aria-expanded="String(!!open[blockId(x, i)])" @click="toggle(blockId(x, i))">
              <span class="ac-arrow">{{ open[blockId(x, i)] ? '▾' : '▸' }}</span> {{ b.title }}
              <span v-if="b.chars != null" class="ac-xp-chars">{{ b.chars }} chars</span>
            </button>
            <pre :id="blockId(x, i)" class="ac-xp-pre" :hidden="!open[blockId(x, i)]">{{ b.body || '' }}</pre>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
