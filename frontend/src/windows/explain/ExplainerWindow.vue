<!-- A per-parcel explainer (assessment or tax description; explain.js). It loads once
     open: the recorded figures first, then, with AI on and reachable, the narration over
     those same figures. AI off or unreachable shows the figures, the Michigan statutes as
     citation links, and a note saying which. Model text is always rendered as text. -->
<script setup>
import { onMounted, ref } from 'vue';
import AvHistoryChart from './AvHistoryChart.vue';
import PinBreakdown from './PinBreakdown.vue';
import { docHtml } from './explain-doc.js';
import { docFileName, figureRows, historyChart, paragraphs, topicMeta } from './explain.js';

const props = defineProps({
  topic: { type: String, required: true },                // 'assessment' | 'tax_description'
  load: { type: Function, required: true },              // → loadExplainer's result
  // The county's full-dataset link past the daily limit (read when it's hit), or null.
  withheldDataUrl: { type: Function, default: () => null },
  doc: { type: Object, default: null },                   // PV_DOC: print / downloadHtml
  county: { type: String, default: 'County' },
  dark: { type: Boolean, default: false },
});

const meta = topicMeta(props.topic);
const state = ref('loading');   // loading | ready | withheld | error
const result = ref(null);
const error = ref('');
const dataUrl = ref(null);

onMounted(async () => {
  try {
    result.value = await props.load();
    state.value = 'ready';
  } catch (err) {
    if (err && err.withheld) {
      const u = props.withheldDataUrl();
      dataUrl.value = typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
      state.value = 'withheld';
    } else {
      error.value = (err && err.message) || 'Please try again.';
      state.value = 'error';
    }
  }
});

const isAssessment = props.topic !== 'tax_description';
// Only http(s) links: the statute corpus is data, and a javascript: URL would run.
const http = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const rows = () => figureRows(result.value.facts);
const chart = () => historyChart(result.value.facts, { dark: props.dark });
const years = () => (result.value.facts.assessed_value_by_year || []).length;

function print() {
  if (props.doc) props.doc.print(docHtml(props.topic, result.value, { county: props.county }));
}
function download() {
  if (props.doc) props.doc.downloadHtml(docHtml(props.topic, result.value, { county: props.county }), docFileName(props.topic, result.value.facts));
}
</script>

<template>
  <div v-if="state === 'loading'" class="pv-xp-loading" role="status">
    <div class="pv-xp-spinner" aria-hidden="true"></div>
    <p>{{ meta.loading }}</p>
  </div>

  <p v-else-if="state === 'withheld'" class="pv-withheld-note" role="note" data-testid="explainer-details-withheld">
    This parcel’s {{ meta.label.toLowerCase() }} details are withheld for the rest of today (daily detail limit). They return
    tomorrow<template v-if="dataUrl">; the county also offers <a :href="dataUrl" target="_blank" rel="noopener">the full dataset</a>.</template><template v-else>.</template>
  </p>

  <template v-else-if="state === 'error'">
    <p class="pv-modal-lead">Couldn’t load this parcel’s {{ meta.label.toLowerCase() }}.</p>
    <p class="pv-modal-note">{{ error }}</p>
  </template>

  <div v-else class="pv-xp">
    <p class="pv-modal-lead">{{ meta.lead }}</p>

    <div v-if="isAssessment" class="pv-xp-figs" role="group" aria-label="Recorded figures">
      <div class="pv-xp-figs-title">By the numbers<span v-if="result.facts.pin" class="pv-xp-pin">{{ result.facts.pin }}</span></div>
      <table class="pv-xp-table">
        <tr v-for="r in rows()" :key="r.label">
          <th>{{ r.label }}<span v-if="r.note" class="pv-xp-note"> · {{ r.note }}</span></th>
          <td>{{ r.value }}</td>
        </tr>
      </table>
      <div v-if="chart()" class="pv-xp-hist">
        <div class="pv-xp-hist-cap">Assessed value — last {{ years() }} years (current year highlighted)</div>
        <AvHistoryChart :chart="chart()" />
      </div>
    </div>

    <div v-else class="pv-xp-figs" role="group" aria-label="Recorded tax description">
      <div class="pv-xp-figs-title">Tax description<span v-if="result.facts.pin" class="pv-xp-pin">{{ result.facts.pin }}</span></div>
      <div v-if="result.facts.description_text" class="pv-xp-desc" data-testid="pv-xp-desc">{{ result.facts.description_text }}</div>
      <div v-else class="pv-xp-desc pv-xp-desc-empty" data-testid="pv-xp-desc">No tax description is on record for this parcel.</div>
      <div v-if="result.facts.type_label" class="pv-xp-desc-type">
        <span class="pv-badge">{{ result.facts.type_label }}</span><template v-if="result.facts.type_note"> {{ result.facts.type_note }}</template>
      </div>
      <PinBreakdown v-if="result.facts.pin_breakdown && result.facts.pin_breakdown.parts && result.facts.pin_breakdown.parts.length" :breakdown="result.facts.pin_breakdown" />
    </div>

    <template v-if="result.explanation">
      <div v-if="result.explanation.summary" class="pv-xp-summary" data-testid="pv-xp-summary">
        <p v-for="(lines, i) in paragraphs(result.explanation.summary)" :key="i">
          <template v-for="(line, j) in lines" :key="j"><br v-if="j > 0">{{ line }}</template>
        </p>
      </div>
      <section v-for="(s, i) in result.explanation.sections || []" :key="i" class="pv-xp-section">
        <h3 class="pv-xp-h">{{ s.heading }}</h3>
        <div class="pv-xp-body">
          <p v-for="(lines, k) in paragraphs(s.body)" :key="k">
            <template v-for="(line, j) in lines" :key="j"><br v-if="j > 0">{{ line }}</template>
          </p>
        </div>
      </section>
      <section v-if="(result.explanation.glossary || []).length" class="pv-xp-section">
        <h3 class="pv-xp-h">Key terms</h3>
        <dl class="pv-xp-gloss">
          <template v-for="g in result.explanation.glossary" :key="g.term"><dt>{{ g.term }}</dt><dd>{{ g.definition }}</dd></template>
        </dl>
      </section>
      <section v-if="(result.explanation.statutes || []).length" class="pv-xp-section">
        <h3 class="pv-xp-h">Michigan law</h3>
        <ul class="pv-xp-statutes">
          <li v-for="s in result.explanation.statutes" :key="s.name + s.citation">
            <span class="pv-xp-stat-name">{{ s.name }}</span> <span class="pv-xp-stat-cite">{{ s.citation }}</span><span class="pv-xp-stat-plain">{{ s.plain }}</span>
          </li>
        </ul>
      </section>
      <p v-if="result.explanation.disclaimer" class="pv-modal-note">{{ result.explanation.disclaimer }}</p>
    </template>

    <template v-else>
      <!-- AI off or unreachable: the curated statutes as citation links. A click opens the
           Sources panel on that statute (pv-citations.js listens for data-cite-source). -->
      <section v-if="result.statutes.length" class="pv-xp-section">
        <h3 class="pv-xp-h">Michigan law</h3>
        <ul class="pv-xp-statutes">
          <li v-for="s in result.statutes" :key="s.name + s.citation">
            <button
              type="button" class="pv-xp-stat-name pv-cite-trigger" data-testid="cite-trigger"
              :data-cite-source="s.citation || s.name || ''" :data-cite-anchor="s.mcl || ''" :data-cite-span="s.name || ''"
            >{{ s.name || '' }}</button><template v-if="http(s.url)"> <a class="pv-xp-stat-ext" :href="http(s.url)" target="_blank" rel="noopener noreferrer" title="Official source" aria-label="Official source">↗</a></template> <span class="pv-xp-stat-cite">{{ s.citation || '' }}</span><span v-if="s.plain" class="pv-xp-stat-plain">{{ s.plain }}</span>
          </li>
        </ul>
      </section>
      <p v-if="result.note" class="pv-modal-note">{{ result.note }}</p>
    </template>

    <div class="pv-xp-actions">
      <button type="button" class="pv-btn-ghost" data-xp="print" @click="print">Print</button>
      <button type="button" class="pv-btn-ghost" data-xp="download" @click="download">Download HTML</button>
    </div>
  </div>
</template>
