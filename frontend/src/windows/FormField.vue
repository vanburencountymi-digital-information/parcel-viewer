<!-- A labelled control in a window's form: the label wraps the control, so the control's
     accessible name is the label text (admin-menu.js's old field() helper). A field holding
     several controls (a button group, a checkbox row plus a button) is a <div> instead: a
     <label> passes a click on its text to its first control, which there picked a colour
     scheme or toggled the hints. -->
<script setup>
defineProps({
  label: { type: String, required: true },
  // A quieter note after the label, e.g. "(optional)".
  note: { type: String, default: '' },
  group: { type: Boolean, default: false },
});
</script>

<template>
  <component :is="group ? 'div' : 'label'" class="pv-field">
    <span class="pv-field-label">{{ label }}<template v-if="note"> <span class="pv-field-opt">{{ note }}</span></template></span>
    <slot />
  </component>
</template>
