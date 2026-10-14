<!-- The Compare table: one column per parcel, one row per field, rows whose values
     differ highlighted. A modal dialog; PV_DIALOG (pv-dialog.js) gives it Esc, focus and
     the Tab trap, as for the viewer's other overlays. -->
<script setup>
import { ref, watch } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
  // pv-dialog.js's { opened, closed }, or null when it isn't on the page.
  dialog: { type: Object, default: null },
});
const state = props.store.state;
const overlay = ref(null);

// Tell PV_DIALOG after each render of the open dialog (a column's × re-renders it, and
// opened() then puts focus back on Close), and when it closes (focus returns).
watch(
  () => [state.open, state.table],
  ([open]) => {
    if (!props.dialog || !overlay.value) return;
    if (open) props.dialog.opened(overlay.value, props.store.close);
    else props.dialog.closed(overlay.value);
  },
  { flush: 'post' },
);
</script>

<template>
  <div
    v-if="state.table"
    ref="overlay"
    class="pv-compare-overlay"
    :hidden="!state.open"
    @click.self="store.close()"
  >
    <div class="pv-compare-modal" role="dialog" aria-modal="true" aria-label="Compare parcels">
      <div class="pv-compare-modal-head">
        <h2 class="pv-compare-modal-title">Compare Parcels</h2>
        <button type="button" class="pv-compare-modal-x" aria-label="Close" @click="store.close()">×</button>
      </div>
      <div class="pv-compare-modal-body">
        <table class="pv-compare-table">
          <thead>
            <tr>
              <th class="pv-cmp-fieldhead">Field</th>
              <th v-for="col in state.table.columns" :key="col.id">
                {{ col.label }}<button
                  type="button"
                  class="pv-cmp-colx"
                  aria-label="Remove from comparison"
                  @click="store.removeColumn(col.id)"
                >×</button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in state.table.rows" :key="row.field" :class="{ 'pv-cmp-differs': row.differs }">
              <th scope="row">
                {{ row.label }}
                <span v-if="row.differs" class="pv-cmp-diffdot" title="values differ" aria-label="values differ"></span>
              </th>
              <td v-for="(cell, i) in row.cells" :key="i">
                <span v-if="cell.withheld" class="pv-withheld">Withheld</span>
                <template v-else>{{ cell.text }}</template>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="pv-compare-note">Differing rows are highlighted. Derived from the assessment roll — not an official valuation.</p>
      </div>
    </div>
  </div>
</template>
