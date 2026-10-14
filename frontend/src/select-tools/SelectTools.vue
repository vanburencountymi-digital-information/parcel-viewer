<!-- The Map Control Panel's Selection Tools pane: box, lasso, attribute filter and buffer
     selection, plus the selection's CSV download and Clear. Mounted into
     #mcp-pane-select; map.js's tab code shows and hides the pane itself. -->
<script setup>
import { computed } from 'vue';
import { OPERATORS } from './filter.js';

const props = defineProps({ store: { type: Object, required: true } });
const state = props.store.state;
const f = state.filter;
const b = state.buffer;

const TOOLS = [
  { id: 'box', label: 'Box', title: 'Box: drag a rectangle to select' },
  { id: 'lasso', label: 'Lasso', title: 'Lasso: freehand draw to select' },
  { id: 'filter', label: 'Filter', title: 'Filter: select by attribute' },
  { id: 'buffer', label: 'Buffer', title: 'Buffer: select parcels within distance of a seed parcel' },
];
const activeLabel = computed(() => ({ box: 'Box Select active', lasso: 'Lasso active' })[state.tool] || '');
</script>

<template>
  <div class="mcp-pane-title" role="heading" aria-level="3">Selection Tools</div>
  <p class="sel-hint">Shift-click parcels to add/remove from selection.</p>
  <div class="sel-tools">
    <button
      v-for="t in TOOLS"
      :id="t.id === 'box' ? 'tool-box-select' : `tool-${t.id}`"
      :key="t.id"
      class="sel-tool-btn"
      :class="{ active: state.tool === t.id }"
      :title="t.title"
      @click="store.setTool(t.id)"
    >
      <svg v-if="t.id === 'box'" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1" y="1" width="11" height="11" rx="1" stroke-dasharray="2.5 1.5" /></svg>
      <svg v-else-if="t.id === 'lasso'" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6.5 1.5C3.5 1.5 1.5 3 1.5 5.5C1.5 8 3.5 9.5 6.5 10C8 10.2 9 9.5 9 8.5" /><circle cx="6.5" cy="1.5" r="1" fill="currentColor" stroke="none" /><path d="M9 8.5 L11 6 L12.5 8" /></svg>
      <svg v-else-if="t.id === 'filter'" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><line x1="1" y1="3" x2="12" y2="3" /><line x1="3" y1="6.5" x2="10" y2="6.5" /><line x1="5" y1="10" x2="8" y2="10" /></svg>
      <svg v-else width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="1.8" stroke-width="1.5" />
        <circle cx="6.5" cy="6.5" r="5" stroke-width="1.2" stroke-dasharray="2.5 1.5" stroke-opacity="0.65" />
        <line x1="6.5" y1="6.5" x2="11.5" y2="6.5" stroke-width="1" />
      </svg>
      {{ t.label }}
    </button>
  </div>

  <!-- Filter panel -->
  <div id="filter-panel" class="filter-panel" :hidden="state.tool !== 'filter'">
    <select id="filter-field" v-model="f.field" class="filter-select" aria-label="Filter field">
      <option value="">— field —</option>
      <option v-for="fld in state.fields" :key="fld.key" :value="fld.key">{{ fld.label }}</option>
    </select>
    <select id="filter-op" v-model="f.op" class="filter-select" aria-label="Filter operator">
      <option v-for="o in OPERATORS" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <input id="filter-value" v-model="f.value" class="filter-input" type="text" placeholder="value…" aria-label="Filter value">
    <div id="filter-match-count" class="filter-match-count" data-testid="filter-match-count">{{ f.note }}</div>
    <div class="filter-btn-row">
      <button id="filter-add-btn" class="filter-btn" @click="store.addFilterMatches()">Add to Selection</button>
      <button id="filter-replace-btn" class="filter-btn filter-btn-replace" @click="store.removeFilterMatches()">Remove from Selection</button>
    </div>
  </div>

  <!-- Buffer panel -->
  <div id="buffer-panel" class="buffer-panel" :hidden="state.tool !== 'buffer'">
    <div id="buffer-seed-status" class="buffer-seed-status" :class="{ 'has-seed': b.seedPin }">
      {{ b.seedPin ? `Seed: ${b.seedPin}` : 'Click a parcel on the map to set the seed' }}
    </div>
    <div id="buffer-controls" class="buffer-controls" :hidden="!b.seedPin">
      <div class="buffer-row">
        <input id="buffer-distance" v-model="b.distance" class="buffer-input" type="number" min="1" step="1" aria-label="Buffer distance">
        <select id="buffer-units" v-model="b.units" class="buffer-select" aria-label="Buffer distance units">
          <option value="feet">Feet</option>
          <option value="miles">Miles</option>
        </select>
      </div>
      <label class="buffer-check-row"><input id="buffer-live-preview" v-model="b.live" type="checkbox"> Live preview</label>
      <label class="buffer-check-row"><input id="buffer-include-seed" v-model="b.includeSeed" type="checkbox"> Include seed parcel</label>
      <div id="buffer-match-count" class="buffer-match-count" data-testid="buffer-match-count">{{ b.note }}</div>
      <div class="buffer-btn-row">
        <button id="buffer-apply-btn" class="buffer-btn buffer-btn-add" @click="store.addBufferMatches()">Add to Selection</button>
        <button id="buffer-remove-btn" class="buffer-btn buffer-btn-remove" @click="store.removeBufferMatches()">Remove from Selection</button>
      </div>
    </div>
    <button id="buffer-cancel-btn" class="buffer-cancel-btn" @click="store.setTool(null)">Cancel</button>
  </div>

  <!-- Active tool bar -->
  <div id="tool-active-bar" class="tool-active-bar" data-testid="tool-active-bar" :hidden="!activeLabel">
    <span class="tool-active-label">{{ activeLabel }}</span>
    <button id="exit-tool-btn" class="exit-tool-btn" @click="store.setTool(null)">Exit</button>
  </div>

  <!-- Selection actions -->
  <div id="sel-actions" class="sel-actions" :hidden="!state.selectedCount">
    <button id="download-csv-btn" class="sel-download-btn" @click="store.downloadCsv()">&#8595; Download CSV</button>
    <button id="clear-selection-btn" class="sel-clear-btn" @click="store.clearSelection()">&#10005; Clear Selection</button>
  </div>
</template>
