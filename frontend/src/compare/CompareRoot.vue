<script setup>
import CompareDialog from './CompareDialog.vue';
import CompareTray from './CompareTray.vue';

defineProps({
  store: { type: Object, required: true },
  dialog: { type: Object, default: null },
});
</script>

<template>
  <CompareTray :store="store" />
  <CompareDialog :store="store" :dialog="dialog" />
</template>
