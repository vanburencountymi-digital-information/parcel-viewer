<!-- The frame of an editable Admin Console module (DIC-2389; the markup admin.js's modules
     each built): the page head with the Edit / Save / Publish toolbar (or the module's own,
     slot "toolbar"), the flash message, the module's banner and cards (slots), and the
     version history. -->
<script setup>
const props = defineProps({
  store: { type: Object, required: true },
  flow: { type: Object, required: true },   // useEditFlow(store)
  title: { type: String, required: true },
  sub: { type: String, required: true },
  editLabel: { type: String, default: 'Edit' },
});
const state = props.store.state;
const when = (v) => (v.created_at || '').slice(0, 19).replace('T', ' ');
</script>

<template>
  <div class="ac-page-head ac-page-head-row">
    <div>
      <h1 class="ac-page-title">{{ title }}</h1>
      <p class="ac-page-sub">{{ sub }}</p>
    </div>
    <div class="ac-toolbar">
      <slot name="toolbar">
        <template v-if="state.editing">
          <button type="button" class="ac-btn ac-btn-primary" data-act="save" @click="flow.save()">Save draft</button>
          <button type="button" class="ac-btn ac-btn-primary" data-act="publish" @click="flow.publish()">Publish</button>
          <button type="button" class="ac-btn" data-act="preview" @click="flow.preview()">Preview in viewer</button>
          <button type="button" class="ac-btn" data-act="cancel" @click="flow.cancel()">Cancel</button>
        </template>
        <template v-else>
          <button type="button" class="ac-btn ac-btn-primary" data-act="edit" @click="flow.edit()">{{ editLabel }}</button>
          <button type="button" class="ac-btn" data-act="history" @click="flow.loadHistory()">Version history</button>
        </template>
      </slot>
    </div>
  </div>
  <div id="ac-flash" role="status" data-testid="ac-flash">
    <div v-if="flow.flash.value" class="ac-flash" :class="'ac-flash-' + flow.flash.value.kind">{{ flow.flash.value.message }}</div>
  </div>
  <slot name="banner" :editing="state.editing" />
  <slot :editing="state.editing" />
  <div id="ac-history">
    <div v-if="flow.history.value" class="ac-card">
      <div class="ac-card-head">
        <h2 class="ac-card-title">Version history</h2>
        <span v-if="flow.history.value.versions" class="ac-card-note">{{ flow.history.value.versions.length }} published version(s)</span>
      </div>
      <p v-if="flow.history.value.loading" class="ac-readonly">Loading…</p>
      <p v-else-if="flow.history.value.message" class="ac-readonly">{{ flow.history.value.message }}</p>
      <table v-else-if="flow.history.value.versions.length" class="ac-table">
        <thead><tr><th>Version</th><th>Note</th><th>By</th><th>When</th><th></th></tr></thead>
        <tbody>
          <tr v-for="v in flow.history.value.versions" :key="v.version">
            <td>v{{ v.version }}</td><td>{{ v.note || '' }}</td><td>{{ v.created_by || '' }}</td><td>{{ when(v) }}</td>
            <td><button type="button" class="ac-btn ac-btn-sm" :data-rollback="v.version" @click="flow.restore(v.version)">Restore</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="ac-readonly">No published versions yet.</p>
    </div>
  </div>
</template>
