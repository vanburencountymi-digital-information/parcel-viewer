<!-- The Parcel Ledger: every recorded event, as a timeline ribbon and a list (newest
     first), filterable by kind. Opening a row or clicking its tick on the ribbon selects it,
     and the inset shows "the parcel as of" that year. -->
<script setup>
import { computed, nextTick, reactive, ref } from 'vue';
import PacketExplain from './PacketExplain.vue';
import { LEDGER, LEDGER_KINDS, ledgerNewestFirst, ledgerX } from './packet-data.js';

const list = ref(null);
const selected = ref(null);
const expanded = reactive({});
const shown = reactive(Object.fromEntries(Object.keys(LEDGER_KINDS).map((k) => [k, true])));

const order = ledgerNewestFirst();
const kinds = Object.entries(LEDGER_KINDS);
const noneShown = computed(() => Object.values(shown).every((on) => !on));
const sel = computed(() => (selected.value == null ? null : LEDGER[selected.value]));
const span = (a, b) => Number((ledgerX(b) - ledgerX(a)).toFixed(1));

function toggleRow(i) {
  expanded[i] = !expanded[i];
  selected.value = i;
}

async function pickTick(i) {
  selected.value = i;
  await nextTick();
  const row = list.value && list.value.querySelector(`.pp-levent[data-li="${i}"]`);
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
}

function toggleKind(k) {
  if (k === 'all') {
    const allOn = Object.values(shown).every(Boolean);
    for (const key of Object.keys(shown)) shown[key] = !allOn;
  } else {
    shown[k] = !shown[k];
  }
}
</script>

<template>
  <p class="pp-note">Every event the county has recorded for this parcel — the backbone the rest of the Packet explains. <span class="pp-samp">sample</span></p>
  <div class="pp-ledger-ribbon">
    <svg class="pp-ribbon-svg" viewBox="0 0 680 70" role="img" aria-label="Timeline of recorded events for this parcel, 1871 to present">
      <rect :x="ledgerX(1871)" y="46" :width="span(1871, 1969)" height="9" fill="rgba(77,124,77,0.12)" />
      <rect :x="ledgerX(1971)" y="46" :width="span(1971, 2026)" height="9" fill="rgba(163,71,59,0.10)" />
      <text :x="ledgerX(1915)" y="52.6" text-anchor="middle" font-size="7.5" fill="#6b7280">Agricultural</text>
      <text :x="ledgerX(2000)" y="52.6" text-anchor="middle" font-size="7.5" fill="#6b7280">Residential</text>
      <line x1="16" y1="42" x2="664" y2="42" stroke="#e5e7eb" stroke-width="1" />
      <g
        v-for="(e, i) in LEDGER" :key="i" class="pp-ltick" :class="{ 'is-sel': selected === i }" :data-li="i"
        :style="{ opacity: shown[e.cat] ? '1' : '0.15' }" @click="pickTick(i)"
      >
        <line :x1="ledgerX(e.y)" y1="24" :x2="ledgerX(e.y)" y2="42" :stroke="LEDGER_KINDS[e.cat].color" stroke-width="1.4" />
        <circle v-if="e.rec" :cx="ledgerX(e.y)" cy="20" r="3.2" :fill="LEDGER_KINDS[e.cat].color" />
        <circle v-else :cx="ledgerX(e.y)" cy="20" r="3" fill="var(--pp-ribbon-bg,#fff)" :stroke="LEDGER_KINDS[e.cat].color" stroke-width="1.4" />
        <rect :x="ledgerX(e.y) - 7" y="6" width="14" height="40" fill="transparent" />
      </g>
      <text v-for="yr in [1900, 1950, 2000]" :key="yr" :x="ledgerX(yr)" y="65" text-anchor="middle" font-size="8" fill="#9ca3af">{{ yr }}</text>
    </svg>
  </div>
  <div class="pp-lfilters">
    <button type="button" class="pp-lchip" :class="{ 'is-off': noneShown }" data-cat="all" @click="toggleKind('all')">All</button>
    <button
      v-for="[k, kind] in kinds" :key="k" type="button" class="pp-lchip" :class="{ 'is-off': !shown[k] }"
      :data-cat="k" :style="{ '--c': kind.color }" @click="toggleKind(k)"
    >{{ kind.label }}</button>
  </div>
  <div class="pp-llegend">
    <span class="pp-ldot" style="--c:#6b7280"></span>recorded<span class="pp-ldot pp-ldot--inf" style="--c:#6b7280;margin-left:10px"></span>inferred from imagery
  </div>
  <div class="pp-lbody">
    <ul ref="list" class="pp-llist">
      <li
        v-for="i in order" v-show="shown[LEDGER[i].cat]" :key="i" class="pp-levent" :class="{ 'is-sel': selected === i }"
        :data-li="i" :data-cat="LEDGER[i].cat"
      >
        <button type="button" class="pp-levent-head" :aria-expanded="String(!!expanded[i])" @click="toggleRow(i)">
          <span class="pp-ldot" :class="{ 'pp-ldot--inf': !LEDGER[i].rec }" :style="{ '--c': LEDGER_KINDS[LEDGER[i].cat].color }"></span>
          <span class="pp-lyear">{{ LEDGER[i].y }}</span>
          <span class="pp-lcat" :style="{ color: LEDGER_KINDS[LEDGER[i].cat].color }">{{ LEDGER_KINDS[LEDGER[i].cat].label }}</span>
          <span class="pp-ltitle">{{ LEDGER[i].t }}</span>
        </button>
        <div v-show="expanded[i]" class="pp-lexplain">
          <p>{{ LEDGER[i].d }}</p>
          <a class="pp-lsrc" href="#" @click.prevent>{{ LEDGER[i].src }} ↗</a>
        </div>
      </li>
    </ul>
    <figure class="pp-linset">
      <div
        class="pp-linset-img"
        :style="sel ? { background: sel.y < 1971 ? 'linear-gradient(135deg,#d8d2c4,#bcae8e)' : 'linear-gradient(135deg,#cfd6c8,#9fb08f)' } : null"
      ></div>
      <figcaption v-if="sel" class="pp-linset-cap">Parcel as of <b>{{ sel.y }}</b> — {{ sel.t }}. <span class="pp-samp">preview</span></figcaption>
      <figcaption v-else class="pp-linset-cap">Select an event to see the parcel at that time. <span class="pp-samp">sample</span></figcaption>
    </figure>
  </div>
  <PacketExplain qa-key="ledger">
    This is the parcel's complete event history — deeds, splits, surveys, assessments, permits, and imagery, newest first.
    <b>Solid dots</b> are recorded in an official document; <b>hollow dots</b> are inferred from aerial imagery and aren't
    authoritative. Expand any row for the plain-language story, click a point on the ribbon to jump to it, or ask about a
    moment below.
  </PacketExplain>
</template>
