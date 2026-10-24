<!-- About Property Assessment: the general overview, shown when no parcel is selected
     (with one, the parcel's own assessment explainer opens instead). -->
<script setup>
const ITEMS = [
  ['Assessed Value (AV)', 'Set by the local assessor at 50% of a property’s estimated True Cash Value (market value).'],
  ['State Equalized Value (SEV)', 'AV after county and state equalization confirm assessments sit at the 50% level uniformly across jurisdictions.'],
  ['Taxable Value (TV)', 'The value you’re actually taxed on. Under Michigan’s Proposal A it rises each year by the lesser of inflation or 5% — until the property transfers, when it “uncaps” to the SEV.'],
  ['Assessing vs. equalization vs. appraisal', 'Assessing values every parcel for taxation; equalization checks those values are uniform across units; an appraisal is an independent market-value opinion for a specific purpose (sale, financing).'],
  ['Where taxes go', 'Millage funds schools, county and township services, libraries, roads, and special assessments.'],
  ['Appeals', 'Disagree with your assessment? Appeal to the March Board of Review, then the Michigan Tax Tribunal.'],
];
</script>

<template>
  <p class="pv-modal-lead">How your assessment works — and what your taxes pay for.</p>
  <div v-for="[h, p] in ITEMS" :key="h" class="pv-help-item">
    <div class="pv-help-h">{{ h }}</div>
    <div class="pv-help-p">{{ p }}</div>
  </div>
  <div class="pv-teaser">
    <div class="pv-teaser-title"><span class="pv-badge">Coming soon</span> Assessment Explainer</div>
    <p class="pv-teaser-body">Soon this window will pull this parcel’s full assessment history and tax detail, cite the relevant Michigan statutes, and use AI to walk through exactly how these numbers were derived and what they fund.</p>
  </div>
</template>
