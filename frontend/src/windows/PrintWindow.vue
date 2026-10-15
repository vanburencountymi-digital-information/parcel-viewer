<!-- Print: a one-page parcel summary (pv-doc.js's PV_DOC) to print or download for the
     selected parcel; with no parcel (or no PV_DOC), print the browser view. Each action
     closes the window first and waits for it to leave the page, so it isn't in the printout. -->
<script setup>
import { nextTick } from 'vue';

const props = defineProps({
  parcel: { type: Object, default: null },
  doc: { type: Object, default: null },     // PV_DOC
  print: { type: Function, required: true },
  close: { type: Function, required: true },
});

const hasDoc = !!(props.doc && props.parcel && props.parcel.pin);

// The modal leaves the page on Vue's next render, not on close(): wait for it, or
// window.print() (which snapshots the page there and then) prints the dialog too.
async function run(action) {
  props.close();
  await nextTick();
  action();
}
</script>

<template>
  <p class="pv-modal-lead">Print or export the current map and parcel details.</p>
  <template v-if="hasDoc">
    <p>
      Export a one-page <strong>parcel summary</strong> for <strong>{{ parcel.pin }}</strong>
      — a snapshot of the current map plus the key facts — as a print/PDF or a standalone HTML file.
    </p>
    <div class="pv-form-actions">
      <button type="button" class="pv-btn-ghost" data-close @click="close">Close</button>
      <button id="pv-dl-summary" type="button" class="pv-btn-ghost" @click="run(() => doc.downloadParcelSummary(parcel))">Download HTML</button>
      <button id="pv-print-summary" type="button" class="pv-btn-primary" @click="run(() => doc.printParcelSummary(parcel))">Print parcel summary</button>
    </div>
    <p class="pv-modal-note">Tip: frame the parcel on the map first — the current map view is captured into the document.</p>
  </template>
  <template v-else>
    <p>Select a parcel to export a formatted parcel summary. For now you can print the current browser view.</p>
    <div class="pv-form-actions">
      <button type="button" class="pv-btn-ghost" data-close @click="close">Close</button>
      <button id="pv-print-now" type="button" class="pv-btn-primary" @click="run(print)">Print current view</button>
    </div>
  </template>
</template>
