<!-- One draft field of an Admin Console editor (DIC-2389; was admin.js's delegated input
     wiring): an input named by its config path that writes its value to the draft with
     its type.
       str   the text as typed
       num   a number; empty saves none (null); anything that isn't a number is ignored
       json  parsed JSON; until it parses, the field is marked (ac-input-err) and ignored
       bool  a checkbox
     It keeps admin.js's data-path / data-type attributes. Other attributes (class,
     placeholder, type="number") pass through to the input. -->
<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
  path: { type: String, required: true },
  type: { type: String, default: 'str' },
  value: { default: null },
});
const bad = ref(false);   // a json field that doesn't parse yet

const shown = computed(() => {
  if (props.type === 'json') return JSON.stringify(props.value);
  return props.value == null ? '' : props.value;
});

function onInput(e) {
  const raw = e.target.value;
  let val;
  if (props.type === 'num') {
    if (raw === '') val = null;
    else { val = Number(raw); if (Number.isNaN(val)) return; }
  } else if (props.type === 'json') {
    try { val = JSON.parse(raw); bad.value = false; } catch { bad.value = true; return; }
  } else {
    val = raw;
  }
  props.store.setDraft(props.path, val);
}
</script>

<template>
  <input
    v-if="type === 'bool'"
    type="checkbox"
    :data-path="path"
    data-type="bool"
    :checked="!!value"
    @change="store.setDraft(path, $event.target.checked)"
  >
  <input
    v-else
    class="ac-input"
    :class="{ 'ac-input-err': bad }"
    :data-path="path"
    :data-type="type"
    :value="shown"
    @input="onInput"
  >
</template>
