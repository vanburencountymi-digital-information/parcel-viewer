// The Parcel Packet's sample content (DIC-2389; was inline in admin-menu.js's openPacket).
// The Packet is a preview: apart from the parcel's own PIN, address, municipality, owner and
// acreage, everything here is illustrative. The live Packet will come from the County
// Knowledge Base.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

/** "October 16, 2026" */
export const packetDate = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

/**
 * The parcel's own facts, with the Packet's placeholders. Past a Protected county's daily
 * detail limit (ADR 0015) the owner is withheld, not unknown.
 */
export function packetFacts(parcel, { withheld = false } = {}) {
  return {
    pin: parcel.pin || '—',
    owner: parcel.owner_name || (withheld ? 'Withheld today (daily detail limit)' : 'Owner on record'),
    address: parcel.site_address || 'Address on file',
    muni: parcel.municipality || 'Van Buren County',
    acres: parcel.acres != null ? parcel.acres.toFixed(2) : '—',
  };
}

// Per-section Q&A bank for the "What this means" panels. The live Packet answers from the
// Knowledge Base; here a few canned exchanges per section show the section-scoped chat.
export const PACKET_QA = {
  assess: { ph: 'Ask about assessment, taxes, or exemptions…', qa: [
    { q: 'Why is taxable value lower than assessed?', a: "Because of Michigan's Proposal A cap. Taxable Value can rise no more than 5% or the rate of inflation per year, even when market value climbs faster — so over time it drifts below the Assessed Value (about half of market). The gap here reflects years of capped growth. (Sample answer.)" },
    { q: 'What would taxes be if I bought today?', a: "At sale the Taxable Value “uncaps” and resets up to the Assessed Value (~$131,100), so a new buyer's bill is figured on roughly that number instead of the current $73,663 — often a noticeable jump. The exact dollars depend on this district's millage rate. (Sample answer.)" }] },
  owner: { ph: 'Ask about ownership, deeds, or liens…', qa: [
    { q: 'Are there any liens on the property?', a: 'The recorded chain shows clean warranty-deed transfers with no liens or encumbrances in the index. The live Packet flags recorded mortgages, tax liens, and easements; a full title search confirms anything unrecorded. (Sample answer.)' },
    { q: 'When did the current owner buy it?', a: '2014, by warranty deed — Liber 1444, Page 933. (Sample answer.)' }] },
  env: { ph: 'Ask about soils, septic, or flood risk…', qa: [
    { q: 'Can I build a pole barn here?', a: "Physically, yes — the gentle 0–6% slope and well-drained Oshtemo sandy loam make an accessory building straightforward, with minimal grading. What actually governs it is zoning: Almena Township's accessory-structure rules set the maximum size, height, and setbacks. The live Packet reads this parcel's zoning district and quotes those limits. (Sample answer.)" },
    { q: 'Is this a good septic site?', a: 'Likely yes. Oshtemo sandy loam percolates quickly, which is what a conventional drain field needs, and the parcel sits outside mapped wetlands and floodplain. Final approval comes from a Van Buren County Health Department perc test. (Sample answer.)' },
    { q: "What's the flood risk?", a: "Low. No part of the parcel lies in a FEMA Special Flood Hazard Area, so flood insurance isn't federally required and floodplain building limits don't apply. The nearest mapped flood zone follows the river corridor, well off this parcel. (Sample answer.)" }] },
  aerial: { ph: "Ask about the parcel's history…", qa: [
    { q: 'When was the house built?', a: 'Comparing frames, the home first appears between the 1968 and 1981 imagery — pointing to construction in the 1970s, consistent with the 1971 parcel split. Assessor records would confirm the exact year. (Sample answer.)' },
    { q: 'Was this land ever farmed?', a: 'The earliest frames show cleared, row-cropped fields; tree cover and the driveway appear in later decades as the parcel shifted to residential use. (Sample answer.)' }] },
  docs: { ph: 'Ask about documents or boundaries…', qa: [
    { q: 'Where are the property corners?', a: "The County Surveyor's field notes for Section 1, T1S R13W record the monuments and measurements that fix the corners. The live Packet links the notes and can drop those corners onto the map. (Sample answer.)" }] },
  taxdesc: { ph: 'Ask about the legal description…', qa: [
    { q: 'What does T1S R13W mean?', a: "Township 1 South, Range 13 West of the Michigan Meridian — a coordinate in the Public Land Survey grid. Townships are counted north/south from the baseline, ranges east/west from the meridian, so it pins the land to Almena Township's survey grid. (Sample answer.)" },
    { q: 'Where is this in the section?', a: 'In the NW¼ of the NW¼ — the northwesternmost 40 acres of Section 1. The parcel is a 200 × 509.6 ft rectangle tucked into that corner, about 2.34 acres. (Sample answer.)' },
    { q: 'What does POB mean?', a: '“Point of Beginning” — the surveyed start of the boundary walk. A metes-and-bounds description leaves the POB, runs each bearing-and-distance call in turn, and must close back to it. (Sample answer.)' }] },
  ledger: { ph: 'Ask about any event…', qa: [
    { q: 'What happened in 2014?', a: 'Two linked events: the property sold to Smith, John & Jane by warranty deed (Liber 1444 Pg 933), and that sale uncapped the taxable value — resetting it from $73,663 toward assessed value and raising the bill. (Sample answer.)' },
    { q: 'Why did the taxes jump?', a: 'The 2014 sale uncapped the taxable value. Under Proposal A it stays capped while ownership is unchanged, then resets up to assessed value at transfer. (Sample answer.)' },
    { q: 'When was the house built?', a: "Around 1968 — the dwelling first appears between the 1955 and 1968 aerials. It's marked inferred (hollow dot) since no recorded permit predates our digital records. (Sample answer.)" }] },
};

const FALLBACK_ANSWER = "That's exactly what the live Packet answers — it would read this parcel's records from the County Knowledge Base and reply right here in plain language. This preview ships with a few sample questions; the production Packet answers anything. (Sample preview.)";

/** The canned answer to a suggested question (any case), else the "the live Packet answers this" note. */
export function answerFor(key, q) {
  const n = String(q).toLowerCase().trim();
  const hit = ((PACKET_QA[key] || {}).qa || []).find((x) => x.q.toLowerCase() === n);
  return hit ? hit.a : FALLBACK_ANSWER;
}

// ── The Parcel Ledger: a mixed event stream; the rest of the Packet is a view onto it ──
export const LEDGER_KINDS = {
  ownership: { label: 'Ownership', color: '#a3473b' },
  tax: { label: 'Tax', color: '#b58d4a' },
  land: { label: 'Land', color: '#4d7c4d' },
  survey: { label: 'Survey', color: '#3b7a8a' },
  regulatory: { label: 'Permit', color: '#7a5ea3' },
  imagery: { label: 'Imagery', color: '#8a8a8a' },
};

// y: year; cat: a LEDGER_KINDS key; rec: recorded in a document (false = inferred from imagery).
export const LEDGER = [
  { y: 1871, cat: 'imagery', rec: true, t: 'Section first platted', d: 'Section 1 appears in the 1873 county plat book with its original owner of record — the earliest documented snapshot of this land.', src: 'Plat book 1873' },
  { y: 1955, cat: 'imagery', rec: true, t: 'Aerial imagery captured', d: 'The earliest aerial frame shows the land in row-crop agriculture.', src: 'Aerial 1955' },
  { y: 1968, cat: 'land', rec: false, t: 'Dwelling constructed', d: 'The home first appears between the 1955 and 1968 aerials, so the build date is inferred from imagery — not a recorded permit.', src: 'Aerial 1968' },
  { y: 1971, cat: 'land', rec: true, t: 'Parcel created from 40-acre split', d: 'Carved from the NW¼ of the NW¼. A split creates a new PIN and legal description; records before this date describe the parent parcel.', src: 'Split record' },
  { y: 1994, cat: 'survey', rec: true, t: 'Boundary survey — corners monumented', d: 'A licensed survey set physical monuments at the corners and recorded the measurements — the authoritative basis for the boundary on the ground.', src: 'Surveyor field notes' },
  { y: 2003, cat: 'ownership', rec: true, t: 'Conveyed to prior owner', d: 'Warranty deed — the strongest form of conveyance, guaranteeing clear title.', src: 'Deed 2003' },
  { y: 2008, cat: 'tax', rec: true, t: 'Drain assessment levied (Smith Drain)', d: 'A charge by the County Drain Commissioner to fund an established drain serving this land; it rides on the tax bill until paid off.', src: 'Assessment roll' },
  { y: 2014, cat: 'ownership', rec: true, t: 'Conveyed to Smith, John & Jane', d: 'Warranty deed — Liber 1444, Page 933.', src: 'Deed 2014' },
  { y: 2014, cat: 'tax', rec: true, t: 'Taxable value uncapped at sale', d: "The sale reset taxable value from the capped $73,663 toward assessed value, raising the next owner's tax bill.", src: 'Assessment record' },
  { y: 2016, cat: 'regulatory', rec: true, t: 'Building permit — pole barn', d: 'An accessory structure was permitted, fixing its size, height, and setbacks under township zoning.', src: 'Permit 2016' },
  { y: 2025, cat: 'imagery', rec: true, t: 'Aerial imagery captured', d: 'The most recent aerial shows current site conditions.', src: 'Aerial 2025' },
];

/** The ledger's indexes, newest first (stable for equal years). */
export const ledgerNewestFirst = () => LEDGER.map((e, i) => i).sort((a, b) => LEDGER[b].y - LEDGER[a].y);

/** The timeline ribbon's x for a year (1871 → 16, 2026 → 664 in its 680-wide viewBox). */
export const ledgerX = (y) => Number((16 + (y - 1871) / (2026 - 1871) * 648).toFixed(1));

export const LEGAL_DESCRIPTION = "COM AT NW COR OF SEC 1, T1S R13W; TH S 89°34' E ALG N SEC LINE 200.0 FT; "
  + "TH S 00°12' W 509.6 FT; TH N 89°34' W 200.0 FT; TH N 00°12' E 509.6 FT TO POB. "
  + 'PART OF NW 1/4 OF NW 1/4, SEC 1, T1S R13W, ALMENA TWP, VAN BUREN CO, MI. 2.34 AC M/L.';

export const AERIAL_YEARS = ['1955', '1968', '1981', '1998', '2012', '2025'];
