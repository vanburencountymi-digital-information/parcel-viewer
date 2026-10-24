<!-- The live Parcel Ledger window: every event the county has recorded for the parcel,
     newest first, on a timeline ribbon. A recorded event links its source document; an
     inferred one says plainly that there's no document of record (§6.4). -->
<script setup>
import { onMounted, reactive, ref } from 'vue';
import { catColor, ribbon, surveyLine } from './ledger.js';

const props = defineProps({
  load: { type: Function, required: true },   // → { facts, provenance }
  core: { type: Object, default: null },       // ISV_LEDGER_CORE (ledgerDisplayModel)
});

const state = ref('loading');   // loading | ready | error
const model = ref(null);
const ticks = ref(null);
const error = ref('');
const expanded = reactive({});

onMounted(async () => {
  try {
    const res = await props.load();
    if (!props.core || !props.core.ledgerDisplayModel) throw new Error('Ledger engine unavailable.');
    model.value = props.core.ledgerDisplayModel(res.facts);
    ticks.value = ribbon(model.value);
    state.value = 'ready';
  } catch (err) {
    error.value = (err && err.message) || 'Please try again.';
    state.value = 'error';
  }
});
</script>

<template>
  <div v-if="state === 'loading'" class="pv-xp-loading" role="status">
    <div class="pv-xp-spinner" aria-hidden="true"></div>
    <p>Loading this parcel’s ledger…</p>
  </div>

  <template v-else-if="state === 'error'">
    <p class="pv-modal-lead">Couldn’t load this parcel’s ledger.</p>
    <p class="pv-modal-note">{{ error }}</p>
  </template>

  <template v-else-if="!model.events.length">
    <p class="pv-modal-lead">No recorded events for this parcel yet.</p>
    <p class="pv-modal-note">The parcel ledger lists deeds, splits, surveys, assessments, permits, and imagery as the county records them.</p>
  </template>

  <div v-else class="pv-xp">
    <p class="pv-modal-lead">Every event the county has recorded for this parcel — newest first.</p>
    <div class="pp-ledger-ribbon">
      <svg v-if="ticks" class="pp-ribbon-svg" viewBox="0 0 680 70" role="img" aria-label="Timeline of recorded events for this parcel">
        <line x1="16" y1="42" x2="664" y2="42" stroke="#e5e7eb" stroke-width="1" />
        <g v-for="(t, i) in ticks" :key="i" class="pp-ltick">
          <line :x1="t.x" y1="24" :x2="t.x" y2="42" :stroke="t.color" stroke-width="1.4" />
          <circle v-if="t.recorded" :cx="t.x" cy="20" r="3.2" :fill="t.color" />
          <circle v-else :cx="t.x" cy="20" r="3" fill="var(--pp-ribbon-bg,#fff)" :stroke="t.color" stroke-width="1.4" />
        </g>
      </svg>
    </div>
    <div class="pp-llegend">
      <span class="pp-ldot" style="--c:#6b7280"></span>recorded<span class="pp-ldot pp-ldot--inf" style="--c:#6b7280;margin-left:10px"></span>inferred (no document of record)
    </div>
    <div class="pp-lbody">
      <ul class="pp-llist">
        <li v-for="(e, i) in model.events" :key="i" class="pp-levent" :data-cat="e.category">
          <button type="button" class="pp-levent-head" :aria-expanded="String(!!expanded[i])" @click="expanded[i] = !expanded[i]">
            <span class="pp-ldot" :class="{ 'pp-ldot--inf': !e.recorded }" :style="{ '--c': catColor(e.category) }"></span>
            <span class="pp-lyear">{{ e.year != null ? e.year : '—' }}</span>
            <span class="pp-lcat" :style="{ color: catColor(e.category) }">{{ e.category_label }}</span>
            <span class="pp-ltitle">{{ e.title }}</span>
          </button>
          <div v-show="expanded[i]" class="pp-lexplain">
            <p v-if="e.description">{{ e.description }}</p>
            <div v-if="surveyLine(e.survey)" class="pp-lsurvey">{{ surveyLine(e.survey) }}</div>
            <a v-if="e.recorded && e.source" class="pp-lsrc" href="#" @click.prevent>{{ e.source }} ↗</a>
            <span v-else class="pp-lsrc pp-lsrc--none">No document of record (inferred)</span>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
