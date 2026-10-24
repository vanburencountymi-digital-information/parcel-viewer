<!-- A colour in an Admin Console module (DIC-2389; was admin.js colorCell): a swatch and
     the hex while viewing; a colour picker and the hex while editing, writing the draft at
     its config path. -->
<script setup>
defineProps({
  store: { type: Object, required: true },
  path: { type: String, required: true },
  value: { type: String, default: null },
  editing: { type: Boolean, default: false },
});
</script>

<template>
  <input
    v-if="editing"
    type="color"
    class="ac-color"
    :data-path="path"
    data-type="str"
    :value="value || '#000000'"
    @input="store.setDraft(path, $event.target.value)"
  >
  <span v-else-if="value" class="ac-swatch" :style="{ background: value }" :title="value"></span>
  {{ ' ' }}<code>{{ value || '—' }}</code>
</template>
