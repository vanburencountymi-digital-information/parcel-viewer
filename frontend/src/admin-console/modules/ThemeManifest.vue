<!-- Theme Manifest (B2 / DIC-578; a Vue module since DIC-2389, was admin.js renderManifest):
     the one versioned, exportable theme manifest the engine boots from, assembled from
     every module and validated through the engine's loadManifest(). It shows the saved
     manifest when there is one (so Save → reopen loses nothing), the capabilities and their
     AI mode, a validated raw JSON editor, Export, and AI autoconfigure (B3): a brief → a
     deterministic draft in the editor, then an optional AI review of it. When the AI
     service is unreachable (B4) autoconfigure stays deterministic and says so. -->
<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import * as admin from '../../shared/admin.js';
import { useEditFlow } from '../edit-flow.js';
import { aiReachable, aiReview, assemble, downloadJson, savedManifest, validate } from '../manifest.js';
import ModuleFrame from '../ModuleFrame.vue';

const props = defineProps({
  store: { type: Object, required: true },
  // Injected so Vitest can fake the engine and the AI service.
  engine: {
    type: Object,
    default: () => ({ assembler: admin.manifestAssembler(), loader: admin.manifestLoader(), composer: admin.themeComposer() }),
  },
  ai: { type: Object, default: () => ({ fetch: (...a) => globalThis.fetch(...a), base: admin.mapBuddyBase }) },
  doc: { type: Object, default: () => document },
  healthEveryMs: { type: Number, default: 30000 },
});
const state = props.store.state;
const flow = useEditFlow(props.store);
const { assembler, loader, composer } = props.engine;

const assembled = () => assemble(assembler, state.config, props.store.countyKey);
const check = (m) => validate(loader, m);

// What the page shows, rebuilt on open and after a save, publish, restore or re-assemble
// (not as the JSON is typed): the saved manifest, else the assembled one.
const shown = ref(null);   // { manifest, saved, res }
const raw = ref('');       // the editor's JSON
function rebuild({ reassemble = false } = {}) {
  const saved = reassemble ? null : savedManifest(state);
  const manifest = saved ? props.store.clone(saved) : assembled();
  shown.value = { manifest, saved: !!saved, res: check(manifest) };
  raw.value = JSON.stringify(manifest, null, 2);
}
const caps = () => Object.entries((shown.value && shown.value.manifest && shown.value.manifest.capabilities) || {});

// ── The editor's actions ──────────────────────────────────────────────────────
const result = ref(null);   // { ok, text } under the editor
function parsed() {
  try { return JSON.parse(raw.value); } catch (e) { result.value = { ok: false, text: '✗ Invalid JSON: ' + e.message }; return null; }
}
function validateRaw() {
  const m = parsed();
  if (!m) return;
  const r = check(m);
  result.value = r.ok
    ? { ok: true, text: '✓ Schema-valid' + (r.applied && r.applied.length ? ' (migrated ' + r.applied.join(', ') + ')' : '') }
    : { ok: false, text: '✗ ' + (r.errors || []).join('; ') };
}
const fileName = (m) => ((m && m.id) || 'theme') + '.manifest.json';
function exportCurrent() {
  const m = savedManifest(state) || assembled();
  downloadJson(props.doc, fileName(m), m);
}
function exportEdited() {
  const m = parsed();
  if (m) downloadJson(props.doc, fileName(m), m);
}
// Saves (and maybe publishes) the edited manifest; never an invalid one.
async function persist(publish) {
  const m = parsed();
  if (!m) return;
  const r = check(m);
  if (!r.ok) { flow.say(false, 'Manifest is not schema-valid — fix it before saving: ' + (r.errors || []).join('; ')); return; }
  props.store.ensureDraft().manifest = r.manifest || m;
  const res = publish ? await props.store.publish('Published theme manifest from console') : await props.store.save();
  if (res.ok) rebuild();
  if (res.ok && !publish) flow.say(true, 'Manifest saved to draft. Reopen to confirm it round-trips.');
  else flow.say(res.ok, res.message);
}

// ── AI autoconfigure (B3) and the AI service's health (B4) ────────────────────
const brief = ref({ topic: 'parcels, assessment and tax', intent: 'public', ai: true });
const health = ref({ checked: false, available: true });
const draftNote = ref(null);   // { ok, text, rationale } after Generate draft
const review = ref(null);      // null, { asking }, or the AI's { rationale, suggestions }
async function checkHealth() {
  const available = await aiReachable(props.ai);
  health.value = { checked: true, available };
}
let healthTimer = null;

function generate() {
  if (!composer) return;
  const base = assembled() || {};
  const wantAi = !!brief.value.ai;
  const b = {
    tenant: base.tenant,
    name: (base.branding && base.branding.name) || (state.config && state.config.name),
    topic: brief.value.topic || 'general',
    intent: brief.value.intent || 'public',
    ai: wantAi,
    sources: base.sources || [],
    center: base.map && base.map.center,
    zoom: base.map && base.map.zoom,
  };
  const out = composer.core(b);
  const draft = out.facts.draftManifest;   // deterministic: the editor's source of truth
  raw.value = JSON.stringify(draft, null, 2);
  const vr = check(draft);
  const useAi = wantAi && health.value.available;
  draftNote.value = {
    ok: vr.ok,
    text: vr.ok ? '✓ schema-valid draft' + (useAi ? '' : ' (AI refinement skipped — service unreachable)') : '✗ ' + (vr.errors || []).join('; '),
    rationale: out.facts.rationale,
  };
  review.value = null;
  if (useAi && vr.ok) {
    review.value = { asking: true };
    aiReview(props.ai, { brief: b, draft, rationale: out.facts.rationale }).then((rf) => { review.value = rf; });
  }
}

onMounted(() => {
  rebuild();
  checkHealth();
  healthTimer = setInterval(checkHealth, props.healthEveryMs);
});
onUnmounted(() => clearInterval(healthTimer));
// A newly loaded or restored config shows (as admin.js redrew the module then).
watch(() => state.config, () => rebuild());
</script>

<template>
  <template v-if="!assembler">
    <div class="ac-page-head">
      <h1 class="ac-page-title">Theme Manifest</h1>
      <p class="ac-page-sub">One versioned, exportable theme manifest assembled from every module.</p>
    </div>
    <div class="ac-banner ac-banner-edit">
      <span>⚠</span>
      <div>The ISV engine bundle isn’t loaded on this page, so the manifest assembler is unavailable. Ensure the <code>/engine/</code> scripts are included.</div>
    </div>
  </template>

  <ModuleFrame v-else-if="shown" :store="store" :flow="flow" title="Theme Manifest" sub="One versioned, exportable manifest assembled from every module — the artifact the engine boots from.">
    <template #toolbar>
      <button type="button" class="ac-btn ac-btn-primary" data-mf="save" @click="persist(false)">Save to draft</button>
      <button type="button" class="ac-btn ac-btn-primary" data-mf="publish" @click="persist(true)">Publish</button>
      <button type="button" class="ac-btn" data-mf="export" @click="exportCurrent">Export</button>
      <button type="button" class="ac-btn" data-mf="reassemble" @click="rebuild({ reassemble: true })">Re-assemble from modules</button>
      <button type="button" class="ac-btn" data-mf="history" @click="flow.loadHistory()">Version history</button>
    </template>

    <template #banner>
      <div v-if="shown.saved" class="ac-banner">
        <span>❖</span>
        <div>Showing the <b>saved manifest</b> from the config store. Edit below and <b>Save to draft</b>, or <b>Re-assemble from modules</b> to regenerate from the current editor values.</div>
      </div>
      <div v-else class="ac-banner">
        <span>⚙</span>
        <div>Assembled from the current module values (<b>not yet saved</b>). <b>Save to draft</b> to persist it as the canonical manifest.</div>
      </div>
      <div v-if="shown.res.ok" class="ac-banner">
        <span>✓</span>
        <div><b>Schema-valid</b> theme manifest (v{{ shown.manifest.manifestVersion }}, tenant <code>{{ shown.manifest.tenant || '—' }}</code>). Round-trips through the same <code>loadManifest()</code> gate CI and the engine boot use.</div>
      </div>
      <div v-else class="ac-banner ac-banner-edit">
        <span>⚠</span>
        <div><b>Not yet schema-valid:</b><ul><li v-for="(e, i) in shown.res.errors || []" :key="i">{{ e }}</li></ul></div>
      </div>
    </template>

    <div class="ac-card">
      <div class="ac-card-head">
        <h2 class="ac-card-title">Capabilities &amp; AI mode</h2>
        <span class="ac-card-note">capability selection + per-capability AI tri-state — owned by the manifest, not any single module</span>
      </div>
      <table class="ac-table">
        <thead><tr><th>Capability</th><th>AI mode</th><th>Disclosure</th></tr></thead>
        <tbody>
          <tr v-for="[id, c] in caps()" :key="id"><td>{{ id }}</td><td><code>{{ c.ai || 'no-ai' }}</code></td><td>{{ c.disclosure || '—' }}</td></tr>
          <tr v-if="!caps().length"><td colspan="3" class="ac-readonly">No capabilities enabled.</td></tr>
        </tbody>
      </table>
    </div>

    <div class="ac-card">
      <div class="ac-card-head">
        <h2 class="ac-card-title">AI autoconfigure (draft)</h2>
        <span class="ac-card-note">a brief → draft manifest + rationale, dropped into the editor below for review. AI proposes, you dispose (§4.12); works with no AI service.</span>
      </div>
      <template v-if="composer">
        <dl class="ac-grid">
          <dt>Topic</dt><dd><input id="ac-ac-topic" v-model="brief.topic" class="ac-input" placeholder="e.g. parcels, zoning and tax"></dd>
          <dt>Intent</dt>
          <dd>
            <select id="ac-ac-intent" v-model="brief.intent" class="ac-input">
              <option value="public">Public</option><option value="staff">Staff</option><option value="staff analysis">Staff analysis</option>
            </select>
          </dd>
          <dt>AI assistant</dt><dd><input id="ac-ac-ai" v-model="brief.ai" type="checkbox"> <span class="ac-card-note">include Map Buddy</span></dd>
        </dl>
        <div id="ac-ac-health" class="ac-card-note">
          <span v-if="health.checked && !health.available" style="color:#9a6700">⚠ AI service unreachable — autoconfigure runs in deterministic baseline mode; the manual builder below is unaffected.</span>
        </div>
        <div class="ac-toolbar" style="margin-top:8px;align-items:center">
          <button type="button" class="ac-btn ac-btn-primary" data-mf="autoconfigure" @click="generate">Generate draft</button>
          <span id="ac-ac-result" class="ac-card-note">
            <template v-if="draftNote">
              <span :style="{ color: draftNote.ok ? '#2f6b4f' : '#b11e2f' }">{{ draftNote.text }}</span> · {{ draftNote.rationale }}
            </template>
          </span>
        </div>
        <div id="ac-ac-refine" style="margin-top:8px">
          <span v-if="review && review.asking" class="ac-card-note">Asking the AI to review the draft…</span>
          <div v-else-if="review" class="ac-banner">
            <span>✦</span>
            <div>
              <b>AI review:</b> {{ review.rationale || '' }}
              <template v-if="(review.suggestions || []).length">
                <br><b>Suggested tweaks</b> (apply in the editor):
                <ul>
                  <li v-for="(s, i) in review.suggestions" :key="i">
                    <code>{{ s.field || '' }}</code> — {{ s.change || '' }}<template v-if="s.why">{{ ' ' }}<span class="ac-card-note">({{ s.why }})</span></template>
                  </li>
                </ul>
              </template>
            </div>
          </div>
        </div>
      </template>
      <p v-else class="ac-readonly">The theme-composer capability isn’t loaded on this page.</p>
    </div>

    <div class="ac-card">
      <div class="ac-card-head">
        <h2 class="ac-card-title">Manifest — complete view &amp; validated raw-edit</h2>
        <span class="ac-card-note">a complete, editable view of the manifest; edit the JSON, Validate, then Save (no one-way doors, §4.11)</span>
      </div>
      <textarea id="ac-mf-raw" v-model="raw" class="ac-input" spellcheck="false" style="width:100%;min-height:340px;font-family:ui-monospace,Menlo,monospace;white-space:pre;tab-size:2"></textarea>
      <div class="ac-toolbar" style="margin-top:8px;align-items:center">
        <button type="button" class="ac-btn ac-btn-primary" data-mf="validate" @click="validateRaw">Validate</button>
        <button type="button" class="ac-btn" data-mf="export-edited" @click="exportEdited">Export edited</button>
        <span id="ac-mf-result" class="ac-card-note"><span v-if="result" :style="{ color: result.ok ? '#2f6b4f' : '#b11e2f' }">{{ result.text }}</span></span>
      </div>
    </div>
  </ModuleFrame>
</template>
