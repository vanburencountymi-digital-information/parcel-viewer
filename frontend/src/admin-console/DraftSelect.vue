<!-- A choice in an Admin Console editor (DIC-2389; was admin.js sel / selR): a select
     named by its config path that writes the picked value to the draft. Options are
     strings, or { v, l } for a value with its own label. -->
<script setup>
defineProps({
  store: { type: Object, required: true },
  path: { type: String, required: true },
  value: { default: null },
  options: { type: Array, required: true },
});
const val = (o) => (o != null && typeof o === 'object' ? o.v : o);
const label = (o) => (o != null && typeof o === 'object' ? o.l : o);
</script>

<template>
  <select class="ac-input ac-input-sm" :data-path="path" data-type="str" @change="store.setDraft(path, $event.target.value)">
    <option v-for="o in options" :key="val(o)" :value="val(o)" :selected="val(o) === (value == null ? '' : value)">{{ label(o) }}</option>
  </select>
</template>
