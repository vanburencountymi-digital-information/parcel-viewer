// The live Parcel Ledger (A7c / DIC-574; moved from pv-ledger.js, DIC-2389): the parcel's
// recorded events from GET /parcel/{id}/history, through the engine's ledger capability:
//
//   /parcel/{id}/history → ISV.invoke('ledger') → { facts, provenance }
//                        → ISV_LEDGER_CORE.ledgerDisplayModel(facts) → LedgerWindow.vue
//
// The ledger is no-AI: its facts and provenance (each event's source document, with honest
// "recorded vs. inferred" states, §6.4) are the whole answer, so AI on and off are the same.

// Category → colour (presentation only; the category key and label come from the core).
// The same palette as the Parcel Packet's sample ledger.
const CAT_COLORS = {
  ownership: '#a3473b', tax: '#b58d4a', land: '#4d7c4d',
  survey: '#3b7a8a', regulatory: '#7a5ea3', imagery: '#8a8a8a', record: '#6b7280',
};
export const catColor = (c) => CAT_COLORS[c] || CAT_COLORS.record;

/**
 * { facts, provenance } for the parcel. Goes through the capability registry when it has
 * the ledger (registered at boot, DIC-2266), else straight to the core.
 */
export async function fetchLedger(parcelId, { base, fetchFn = globalThis.fetch, isv = null, core = null }) {
  if (parcelId == null) throw new Error('no parcel id');
  const r = await fetchFn(`${base}/parcel/${encodeURIComponent(parcelId)}/history`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const input = { events: (data && data.events) || [] };
  if (isv && isv.invoke) {
    const res = await isv.invoke('ledger', input, { ai: false });
    return { facts: res.facts, provenance: res.provenance };
  }
  if (core) return core.core(input);
  return { facts: { events: [], event_count: 0 }, provenance: [] };
}

/** The timeline ribbon's ticks (in a 680-wide viewBox), or null when the events span no years. */
export function ribbon(model) {
  if (!model.span || model.span.from === model.span.to) return null;
  const y0 = model.span.from, y1 = model.span.to + 1;
  const x = (y) => Number((16 + (y - y0) / (y1 - y0) * 648).toFixed(1));
  return model.events.filter((e) => e.year != null)
    .map((e) => ({ x: x(e.year), color: catColor(e.category), recorded: !!e.recorded }));
}

/** A surveyed event's closure, precision and adjustment, as one line ('' when none). */
export function surveyLine(survey) {
  if (!survey) return '';
  const bits = [];
  if (survey.closure_error != null) bits.push(`closure ${survey.closure_error} ft`);
  if (survey.precision_ratio != null) bits.push(`1:${survey.precision_ratio}`);
  if (survey.bowditch_applied) bits.push('Bowditch-adjusted');
  return bits.join(' · ');
}
