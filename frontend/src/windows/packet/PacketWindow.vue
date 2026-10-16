<!-- The Parcel Packet (a sample preview): "comprehensive property intelligence" for the
     selected parcel. Only its PIN, address, municipality, owner and acreage are real; the
     rest shows what the live Packet will hold (packet-data.js). Share / Embed and Monitor
     are previews of paid add-ons. -->
<script setup>
import { nextTick, onBeforeUnmount, ref } from 'vue';
import PacketExplain from './PacketExplain.vue';
import PacketLedger from './PacketLedger.vue';
import { AERIAL_YEARS, LEGAL_DESCRIPTION, packetDate, packetFacts } from './packet-data.js';

const props = defineProps({
  // null when no parcel is selected: the window says to pick one.
  parcel: { type: Object, default: null },
  // Past a Protected county's daily detail limit (pv-access.js).
  withheld: { type: Boolean, default: false },
  now: { type: Date, default: () => new Date() },
  // Copies text (the clipboard API by default).
  copy: { type: Function, default: (text) => navigator.clipboard && navigator.clipboard.writeText(text) },
});

const f = props.parcel ? packetFacts(props.parcel, { withheld: props.withheld }) : null;
const date = packetDate(props.now);
const formats = ['Interactive', 'PDF', 'Audio', 'Video', 'AI Q&A session'];

const shareOpen = ref(false);
const sharePanel = ref(null);
const copied = ref({});
const monitored = ref(false);
const timers = new Set();

const shareLink = f && `https://packet.dicelabs.org/p/${f.pin}?s=ab12cd`;
const embedSnippet = f && `<iframe src="https://packet.dicelabs.org/embed/${f.pin}?k=YOUR_API_KEY" width="100%" height="640" style="border:0"></iframe>`;

async function toggleShare() {
  shareOpen.value = !shareOpen.value;
  if (!shareOpen.value) return;
  await nextTick();
  if (sharePanel.value && sharePanel.value.scrollIntoView) sharePanel.value.scrollIntoView({ block: 'nearest' });
}

function onCopy(which, text) {
  try { Promise.resolve(props.copy(text)).catch(() => {}); } catch { /* the label still confirms */ }
  copied.value = { ...copied.value, [which]: true };
  const t = setTimeout(() => {
    timers.delete(t);
    copied.value = { ...copied.value, [which]: false };
  }, 1400);
  timers.add(t);
}

onBeforeUnmount(() => timers.forEach(clearTimeout));
</script>

<template>
  <p v-if="!parcel" class="pv-modal-lead">Select a parcel first, then open its Packet.</p>
  <div v-else class="pp">
    <div class="pp-hero">
      <div class="pp-hero-row"><span class="pp-eyebrow">PARCEL PACKET</span><span class="pp-preview-badge">Sample preview</span></div>
      <div class="pp-hero-addr">{{ f.address }}</div>
      <div class="pp-hero-sub">{{ f.pin }} &middot; {{ f.muni }} &middot; {{ f.owner }}</div>
      <div class="pp-hero-meta">Comprehensive property intelligence &middot; generated {{ date }}</div>
    </div>

    <div class="pp-formats">
      <span class="pp-formats-l">Available as</span>
      <span v-for="x in formats" :key="x" class="pp-chip">{{ x }}</span>
      <button
        id="pp-share-btn" type="button" class="pp-share-btn" :class="{ 'is-on': shareOpen }"
        :aria-expanded="String(shareOpen)" @click="toggleShare"
      >🔗 Share / Embed</button>
    </div>

    <div class="pp-body">
      <div id="pp-share" ref="sharePanel" class="pp-share" :hidden="!shareOpen">
        <div class="pp-share-h"><span aria-hidden="true">🔗</span> Share this Packet <span class="pp-samp">paid add-on</span></div>
        <p class="pp-share-sub">Title companies and agents can hand a client a live Packet or embed it on a listing. Sharing is a metered add-on — billed per share or by monthly plan, with API limits and co-branding.</p>
        <label class="pp-share-field">
          <span class="pp-share-lbl">Shareable link</span>
          <span class="pp-share-row">
            <input class="pp-share-in" readonly :value="shareLink">
            <button type="button" class="pp-share-copy" data-copy="link" @click="onCopy('link', shareLink)">{{ copied.link ? 'Copied ✓' : 'Copy' }}</button>
          </span>
        </label>
        <label class="pp-share-field">
          <span class="pp-share-lbl">Embed snippet</span>
          <span class="pp-share-row">
            <textarea class="pp-share-in" readonly rows="2" :value="embedSnippet"></textarea>
            <button type="button" class="pp-share-copy" data-copy="embed" @click="onCopy('embed', embedSnippet)">{{ copied.embed ? 'Copied ✓' : 'Copy' }}</button>
          </span>
        </label>
        <ul class="pp-share-terms">
          <li><b>Per-share fee</b> or monthly embed plan <span class="pp-samp">sample</span></li>
          <li><b>API rate limits</b> by tier — views/day &amp; allowed domains</li>
          <li><b>Co-branding</b> — your logo alongside “Powered by DICE Labs”</li>
          <li><b>Client view</b> hides internal/admin-only fields</li>
        </ul>
      </div>

      <div class="pp-ai">
        <div class="pp-ai-h"><span aria-hidden="true">✨</span> A.I. Summary</div>
        <p class="pp-ai-text">
          This {{ f.acres }}-acre parcel in {{ f.muni }}, held by {{ f.owner }}, is located at {{ f.address }}. Assessed and
          taxable values have trended steadily over the past five years, and a principal-residence exemption is on file. The
          property carries no FEMA flood designation and no mapped wetlands within 200&nbsp;ft; soils are well-drained sandy
          loam. Two parcels border it to the north and west.
          <em>(Illustrative — the live Packet writes this on demand from the Knowledge Base.)</em>
        </p>
      </div>

      <div class="pp-facts">
        <div class="pp-fact"><div class="pp-fact-v">{{ f.acres }} ac</div><div class="pp-fact-l">Acreage</div></div>
        <div v-for="[l, v] in [['Class', '401 — Residential'], ['Assessed Value', '$131,100'], ['Taxable Value', '$73,663'], ['PRE', '100%'], ['School', 'Gobles Public']]" :key="l" class="pp-fact">
          <div class="pp-fact-v">{{ v }}<span class="pp-samp">sample</span></div><div class="pp-fact-l">{{ l }}</div>
        </div>
      </div>

      <section class="pp-section">
        <h3 class="pp-section-h">Parcel Ledger</h3>
        <PacketLedger />
      </section>

      <section class="pp-section">
        <h3 class="pp-section-h">Assessment &amp; Tax</h3>
        <table class="pp-table">
          <thead><tr><th></th><th>Current</th><th>Prior</th></tr></thead>
          <tbody>
            <tr><td>Assessed Value</td><td>$131,100</td><td>$124,800</td></tr>
            <tr><td>Taxable Value</td><td>$73,663</td><td>$71,940</td></tr>
            <tr><td>Est. Market Value</td><td>$262,200</td><td>$249,600</td></tr>
          </tbody>
        </table>
        <p class="pp-note">Includes a 5-year assessed-value history. <span class="pp-samp">sample</span></p>
        <PacketExplain qa-key="assess">
          In Michigan the <b>Assessed Value</b> is set at about half of market value, while the <b>Taxable Value</b> — the figure
          your bill is actually calculated on — can rise no faster than inflation or 5% a year under Proposal A. That cap is why
          the taxable value sits well below the assessed value here, and why a long-time owner often pays less than a recent buyer
          would on an identical home. The <b>100% Principal Residence Exemption</b> confirms this is the owner's primary home,
          exempting it from the 18-mill local school operating tax and noticeably lowering the bill.
        </PacketExplain>
      </section>

      <section class="pp-section">
        <h3 class="pp-section-h">Ownership</h3>
        <ul class="pp-timeline">
          <li><span class="pp-t-date">2014</span>Conveyed to {{ f.owner }} (warranty deed)</li>
          <li><span class="pp-t-date">2003</span>Conveyed to prior owner</li>
          <li><span class="pp-t-date">1971</span>Parcel created from a 40-acre split</li>
        </ul>
        <p class="pp-note">Full chain of title + recorded instruments. <span class="pp-samp">sample</span></p>
        <PacketExplain qa-key="owner">
          The <b>chain of title</b> traces ownership in an unbroken line back to the original 1971 parcel split — no gaps, breaks,
          or competing claims appear in the record, which is exactly what a title company verifies before issuing title
          insurance. Each transfer shown is backed by a recorded <b>warranty deed</b>, the strongest form of conveyance, in which
          the seller guarantees clear ownership free of undisclosed liens.
        </PacketExplain>
      </section>

      <section class="pp-section">
        <h3 class="pp-section-h">Tax Description</h3>
        <div class="pp-legal">
          <div class="pp-legal-doc">{{ LEGAL_DESCRIPTION }}</div>
          <figure class="pp-aliquot">
            <!-- The section, its quarters, and the NW¼ of the NW¼ where the parcel sits. -->
            <svg class="pp-aliquot-svg" viewBox="0 0 200 206" role="img" aria-label="Section diagram: the parcel lies in the northwest quarter of the northwest quarter of Section 1">
              <rect x="18" y="18" width="160" height="160" fill="var(--pp-aliquot-bg,#f5f3f0)" stroke="#9ca3af" stroke-width="1.5" />
              <rect x="18" y="18" width="80" height="80" fill="rgba(163,71,59,0.10)" />
              <rect x="18" y="18" width="40" height="40" fill="rgba(163,71,59,0.30)" />
              <g stroke="#cbd5e1" stroke-width="0.8">
                <line x1="58" y1="18" x2="58" y2="178" /><line x1="138" y1="18" x2="138" y2="178" />
                <line x1="18" y1="58" x2="178" y2="58" /><line x1="18" y1="138" x2="178" y2="138" />
              </g>
              <g stroke="#6b7280" stroke-width="1.4"><line x1="98" y1="18" x2="98" y2="178" /><line x1="18" y1="98" x2="178" y2="98" /></g>
              <rect x="21" y="21" width="6.1" height="15.4" fill="var(--ui-accent)" stroke="#fff" stroke-width="0.5" />
              <text x="186" y="14" font-size="11" font-weight="700" fill="currentColor">N</text>
              <line x1="183" y1="23" x2="183" y2="9" stroke="currentColor" stroke-width="1.2" />
              <path d="M183 6 l-2.6 4.5 h5.2 z" fill="currentColor" />
              <text x="98" y="196" text-anchor="middle" font-size="9.5" fill="currentColor">Sec 1 · 640 ac · quarters &amp; quarter-quarters</text>
            </svg>
            <figcaption class="pp-aliquot-cap">Parcel sits in the <b>NW¼ of the NW¼</b></figcaption>
          </figure>
        </div>
        <p class="pp-note">Verbatim legal description from the tax roll. <span class="pp-samp">sample</span></p>
        <PacketExplain qa-key="taxdesc">
          This is a <b>metes-and-bounds</b> description — it walks the boundary leg by leg. <b>T1S R13W</b> places the land in the
          Public Land Survey grid (Township 1 South, Range 13 West of the Michigan Meridian); <b>Sec 1</b> is one square mile —
          640 acres — divided into quarters and quarter-quarters. <b>“COM AT NW COR”</b> starts at the section's northwest corner,
          and each <b>“TH”</b> (thence) gives a compass bearing and a distance in feet until the boundary closes back at the
          <b>“POB”</b> (point of beginning). Those calls enclose a 200 × 509.6 ft rectangle in the <b>NW¼ of the NW¼</b> — the
          northwest 40 acres of the section — about 2.34 acres. <b>M/L</b> means “more or less.”
        </PacketExplain>
      </section>

      <section class="pp-section">
        <h3 class="pp-section-h">Environmental</h3>
        <div class="pp-pills">
          <span class="pp-pill pp-ok">No FEMA flood zone</span>
          <span class="pp-pill pp-ok">No NWI wetlands within 200 ft</span>
          <span class="pp-pill">Soils: Oshtemo sandy loam</span>
          <span class="pp-pill">Slope: 0–6%</span>
        </div>
        <PacketExplain qa-key="env">
          <b>Oshtemo sandy loam</b> is a deep, well-drained soil — water moves through it quickly, so the parcel sheds rain well
          and is generally favorable for a conventional septic field and stable building foundations. The trade-off is that sandy
          soils hold less water and fewer nutrients, so lawns, gardens, or crops may need irrigation in a dry summer. The gentle
          <b>0–6% slope</b> means little grading is needed to build and erosion risk is low. Because no part of the parcel lies in
          a <b>FEMA flood zone</b> or a <b>mapped wetland</b>, it avoids the building setbacks, state permits, and mandatory flood
          insurance those designations would otherwise trigger.
        </PacketExplain>
      </section>

      <section class="pp-section">
        <h3 class="pp-section-h">70-Year Aerial History</h3>
        <div class="pp-aerials">
          <div v-for="y in AERIAL_YEARS" :key="y" class="pp-aerial"><div class="pp-aerial-img"></div><span>{{ y }}</span></div>
        </div>
        <p class="pp-note">Swipe through decades of imagery in the live Packet. <span class="pp-samp">sample</span></p>
        <PacketExplain qa-key="aerial">
          Stacking aerial imagery across seven decades turns a single snapshot into a story: you can see roughly when the home and
          outbuildings were built, how the tree line and driveway shifted, and whether the land was ever farmed, cleared, or
          filled. That history is often invisible in today's records but matters for drainage, buried structures, and questions
          about prior land use.
        </PacketExplain>
      </section>

      <section class="pp-section">
        <h3 class="pp-section-h">Documents &amp; Survey Notes</h3>
        <ul class="pp-docs">
          <li>📄 Warranty Deed (2014) — Liber 1444, Page 933</li>
          <li>📄 Tax statement (current year)</li>
          <li>📐 County Surveyor field notes — Section 1, T1S R13W</li>
        </ul>
        <p class="pp-note">Linked from the County Knowledge Base — searchable and AI-readable. <span class="pp-samp">sample</span></p>
        <PacketExplain qa-key="docs">
          These records are the primary sources behind everything above — the <b>deed</b> establishes ownership, the <b>tax
          statement</b> itemizes the bill, and the <b>County Surveyor's field notes</b> document the actual monuments and
          measurements that fix this parcel's boundaries on the ground. In the live Packet each is linked, full-text searchable,
          and readable by the A.I. so you can simply ask a question instead of digging through filings.
        </PacketExplain>
      </section>

      <div class="pp-monitor">
        <div class="pp-monitor-h">🔔 Monitor this parcel</div>
        <p>Get alerted when assessment, ownership, boundaries, or permits change. A monitoring subscription keeps this Packet live.</p>
        <button id="pp-monitor-btn" type="button" class="pv-btn-primary" :disabled="monitored" @click="monitored = true">
          {{ monitored ? 'On the roadmap ✓' : 'Subscribe to monitoring' }}
        </button>
      </div>

      <p class="pp-footer">
        DICE Labs &middot; Parcel Packet (preview). Illustrative sample for demonstration — not a legal record of survey.
        The live Packet is generated on demand from the County Knowledge Base.
      </p>
    </div>
  </div>
</template>
