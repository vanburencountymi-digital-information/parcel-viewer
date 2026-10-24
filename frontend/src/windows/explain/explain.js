// The per-parcel explainers (DIC-370 assessment, DIC-369 tax description), moved from
// pv-explain.js (DIC-2389). Two engines, verify-don't-trust:
//   1. the deterministic truth: this parcel's recorded figures from the API (/parcel/{id}),
//      assembled by the engine's explainer core. We render these; the model never does.
//   2. the AI teacher: Map Buddy's /explain narrates ONLY those figures and cites Michigan
//      law from a vetted list (map-buddy/backend/agent.py).
// With AI off, or on but unreachable, the window degrades to the facts plus the curated
// statute links (§4.5) — the same statutes the AI narrates from (§4.6).
//
// Everything here returns data; ExplainerWindow.vue renders it and explain-doc.js prints it.

export const TOPICS = {
  assessment: {
    label: 'Property Assessment',
    lead: 'A plain-language breakdown of this parcel’s assessment—grounded in the county’s recorded figures.',
    loading: 'Assembling this parcel’s assessment…',
    docSubtitle: 'Property Assessment',
    docSlug: 'assessment',
    fallbackTeaser: 'The AI walkthrough couldn’t be reached right now — showing this parcel’s recorded figures and the Michigan statutes they’re based on. Try again later for the walkthrough.',
  },
  tax_description: {
    label: 'Tax Description',
    lead: 'What this parcel’s tax description says, in plain language—and why it isn’t a legal survey.',
    loading: 'Loading this parcel’s tax description…',
    docSubtitle: 'Tax Description',
    docSlug: 'tax-description',
    fallbackTeaser: 'The AI walkthrough couldn’t be reached right now — the tax description above is this parcel’s recorded text. Try again later for the walkthrough.',
  },
};
export const topicMeta = (topic) => TOPICS[topic] || TOPICS.assessment;

export const AI_OFF_NOTE = "AI walkthrough is off — showing this parcel's recorded figures and the Michigan statutes they're based on.";

/**
 * Where AI stands: 'off' (the visitor turned it off), 'down' (on, but known unreachable)
 * or 'on'. "Off" and "down" degrade the same way but must not be described the same way.
 * aiMode is pv-ai-mode.js's controller; prefs is PV_PREFS (before the controller existed).
 */
export function aiState({ aiMode, prefs } = {}) {
  const hasPref = prefs && typeof prefs.getAiMode === 'function';
  // Did the visitor turn it off?
  let chosenOff = false;
  if (aiMode && typeof aiMode.isOn === 'function') chosenOff = !aiMode.isOn();
  else if (hasPref) chosenOff = prefs.getAiMode() !== 'on';
  if (chosenOff) return 'off';
  // On: is it usable?
  let usable;
  if (aiMode && typeof aiMode.isEffective === 'function') usable = aiMode.isEffective();
  else if (hasPref) usable = prefs.getAiMode() === 'on';
  else usable = !(prefs && (prefs.aiMode === 'off' || prefs.aiMode === false));   // legacy pref
  return usable ? 'on' : 'down';
}

// ── 1. The truth layer ───────────────────────────────────────────────────────

/**
 * The parcel record both explainers read. Past a Protected county's daily detail limit
 * (ADR 0015) its owner and value fields are empty, so this rejects with .withheld and the
 * window says so instead of explaining blanks.
 */
export async function fetchRecord(id, { base, fetchFn = globalThis.fetch, access = null }) {
  const r = await fetchFn(`${base}/parcel/${encodeURIComponent(id)}`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const feat = await r.json();
  if (access) access.note(feat);
  if (access && access.isWithheld(feat && feat.properties)) throw Object.assign(new Error('details withheld'), { withheld: true });
  return feat;
}

/** The topic's facts, from the record, through the engine's explainer core. */
export function buildFacts(topic, record, parcel, { core, county }) {
  const p = (record && record.properties) || {};
  if (topic === 'tax_description') {
    return core.buildTaxDescriptionFacts(p, { parcelNumber: county.parcelNumber || null, pinFallback: parcel && parcel.pin });
  }
  return core.buildAssessmentFacts(p, {
    labels: county.labels, pinFallback: parcel && parcel.pin, rollYear: (county.assessing || {}).rollYear,
  });
}

// The curated MI tax-statute corpus: the AI-off citation links AND the AI-on citable set.
let statutesCache = null;
export function loadStatutes(fetchFn = globalThis.fetch) {
  if (!statutesCache) {
    statutesCache = fetchFn('/engine/data/mi-tax-statutes.json', { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : { statutes: [] }))
      .then((j) => (j && j.statutes) || [])
      .catch(() => []);
  }
  return statutesCache;
}
export const resetStatutesCache = () => { statutesCache = null; };

// ── 2. The AI teacher ────────────────────────────────────────────────────────

/** The structured explanation, or null on any failure (the caller degrades to facts). */
export async function fetchExplanation(facts, topic, { base, fetchFn = globalThis.fetch }) {
  try {
    const r = await fetchFn(`${base}/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic || 'assessment', facts }),
    });
    if (!r.ok) return null;
    const res = await r.json();
    return res && res.ok && res.explanation ? res.explanation : null;
  } catch {
    return null;
  }
}

/**
 * Everything the window shows: { facts, statutes, explanation, note }. explanation is null
 * when AI is off, down, failed, or there's nothing to narrate (an empty tax description);
 * note says which. Rejects (with .withheld past the daily limit) when the record can't load.
 */
export async function loadExplainer(topic, parcel, deps) {
  const { core, county = {}, apiBase, aiBase, fetchFn = globalThis.fetch, access = null, ai = 'on' } = deps;
  if (!core) throw new Error('The explainer engine isn’t loaded.');
  const [record, statutes] = await Promise.all([
    fetchRecord(parcel.id, { base: apiBase, fetchFn, access }),
    loadStatutes(fetchFn),
  ]);
  const facts = buildFacts(topic, record, parcel, { core, county });
  const meta = topicMeta(topic);
  const offNote = statutes.length ? AI_OFF_NOTE : '';
  const emptyDescription = topic === 'tax_description' && !facts.description_text;
  if (emptyDescription || ai === 'off') return { facts, statutes, explanation: null, note: offNote };
  if (ai === 'down') return { facts, statutes, explanation: null, note: meta.fallbackTeaser };
  const explanation = await fetchExplanation(facts, topic, { base: aiBase, fetchFn });
  return { facts, statutes, explanation, note: explanation ? '' : meta.fallbackTeaser };
}

// ── Presentation helpers (shared by the window and the printed document) ──────

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isNaN(n) ? null : n; };
export const money = (v) => { const n = num(v); return n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`; };

/** The assessment's recorded figures, as table rows (missing ones left out, never guessed). */
export function figureRows(f) {
  const rows = [];
  const add = (label, value, note = '') => { if (value != null && value !== '') rows.push({ label, value, note }); };
  add('Assessed Value (AV)', money(f.assessed_value), 'assessor’s estimate of 50% of market value');
  add('Taxable Value (TV)', money(f.taxable_value), 'the value your millage is applied to (capped by Proposal A)');
  add('True Cash Value', money(f.true_cash_value_estimate), 'estimated full market value (about 2× AV)');
  if (f.pre_percent != null) add('Principal Residence Exemption', `${f.pre_percent}%`, 'share exempt from local school operating tax');
  add('Classification', f.classification, 'Michigan STC property class');
  add('School District', f.school_district, '');
  return rows;
}

/** AI prose → paragraphs (blank-line separated), each a list of lines. */
export const paragraphs = (text) => (text
  ? String(text).split(/\n\s*\n/).map((p) => p.trim().split('\n'))
  : []);

/**
 * The 5-year assessed-value chart, as data both renderers draw: bars on a min→max scale
 * (so narrow year-over-year changes stay visible; the exact value sits above each bar), the
 * current year highlighted. null with fewer than two values. dark: the viewer's dark theme
 * (never for the printed document).
 */
export function historyChart(f, { dark = false } = {}) {
  const vals = (f.assessed_value_history || []).slice().reverse();   // newest-first → oldest-first
  const valid = vals.filter((v) => v != null);
  if (valid.length < 2) return null;
  const curYear = parseInt(f.roll_year, 10) || new Date().getFullYear();
  const maxV = Math.max(...valid), minV = Math.min(...valid);
  const W = 320, H = 96, labelH = 15, valueH = 13, areaH = H - labelH - valueH;
  const n = vals.length, colW = W / n, barW = colW * 0.5;
  const colors = dark
    ? { value: '#b09a7a', year: '#b9bdc4', top: '#6b5a38', bottom: '#4a3e26', current: '#d4a862' }
    : { value: '#6D5C52', year: '#4b5563', top: '#CBAB7A', bottom: '#B58D4A', current: '#8B6535' };
  const bars = vals.map((v, i) => {
    const cx = colW * i + colW / 2;
    const year = curYear - (n - 1 - i);
    if (v == null) return { cx, year, bar: null };
    const frac = maxV === minV ? 1 : 0.22 + 0.78 * (v - minV) / (maxV - minV);
    const h = Math.max(3, Math.round(frac * areaH));
    const y = valueH + areaH - h;
    return {
      cx, year,
      bar: { x: Number((cx - barW / 2).toFixed(1)), y: Number(y.toFixed(1)), w: Number(barW.toFixed(1)), h, current: i === n - 1 },
      label: `$${Math.round(v / 1000)}k`, labelY: Number((y - 3).toFixed(1)),
    };
  });
  return { W, H, yearY: H - 3, colors, bars };
}

// Colours for the parcel-number parts (cycling past six).
export const PIN_COLORS = ['#A3473B', '#B58D4A', '#2F6B4F', '#1F5E80', '#7A3B6B', '#475569'];

/** "Property Assessment — 80-14-…" */
export const explainerTitle = (topic, parcel) => topicMeta(topic).label + (parcel && parcel.pin ? ` — ${parcel.pin}` : '');

/** The file name for Download HTML. */
export const docFileName = (topic, facts) => `${topicMeta(topic).docSlug}-${String(facts.pin || 'parcel').replace(/[^\w.-]/g, '_')}.html`;
