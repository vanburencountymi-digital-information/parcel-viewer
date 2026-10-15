<!-- Data Request: the county's request form (a JotForm) embedded in the window. If the frame
     is blocked (network, CSP, an extension), the footer link opens it in a new tab. -->
<script setup>
defineProps({ url: { type: String, required: true } });
</script>

<template>
  <div class="pv-embed">
    <iframe
      class="pv-embed-frame" :src="url" title="Data Request form"
      allow="geolocation; microphone; camera; fullscreen; payment" allowtransparency="true"
    ></iframe>
    <div class="pv-embed-foot">
      Form not loading?
      <a :href="url" target="_blank" rel="noopener">Open it in a new tab &#8599;</a>
    </div>
  </div>
</template>
