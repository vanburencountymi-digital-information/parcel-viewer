// The Compare table's model: the engine's `compare` aggregator over a /cohort response,
// formatted for display. Pure (no DOM, no globals), so Vitest checks it directly.
// Values are plain text: Vue escapes them when it renders, so nothing here builds HTML.

// The fields shown as comparison rows; `fmt` picks the formatter.
export const COMPARE_FIELDS = [
  { key: 'pin', label: 'Parcel ID' },
  { key: 'PCOMBINED', label: 'Address' },
  { key: 'owner_name', label: 'Owner' },
  { key: 'prop_class', label: 'Class', fmt: 'class' },
  { key: 'gis_acres', label: 'Acres', fmt: 'acres' },
  { key: 'assessed_value', label: 'Assessed Value', fmt: 'money' },
  { key: 'taxable_value', label: 'Taxable Value', fmt: 'money' },
  { key: 'av_per_acre', label: 'Assessed $/acre', fmt: 'money' },
  { key: 'school_dist', label: 'School District', fmt: 'school' },
];
const FMT_BY_KEY = Object.fromEntries(COMPARE_FIELDS.map((f) => [f.key, f.fmt || 'text']));

/** One value as display text; `labels` is the county config's code → name maps. */
export function formatValue(key, v, labels = {}) {
  if (v == null || v === '') return '—';
  switch (FMT_BY_KEY[key]) {
    case 'money': { const n = Number(v); return Number.isNaN(n) ? String(v) : '$' + Math.round(n).toLocaleString(); }
    case 'acres': { const a = Number(v); return Number.isNaN(a) ? String(v) : a.toFixed(2) + ' ac'; }
    case 'class': { const c = String(v).trim(); const nm = (labels.propClass || {})[c]; return nm ? `${c} – ${nm}` : c; }
    case 'school': { const s = String(v).trim(); return (labels.schoolDist || {})[s] || s; }
    default: return String(v);
  }
}

/**
 * The table for a /cohort response: { columns: [{ id, label }], rows: [{ field, label,
 * differs, cells: [{ text, withheld }] }] }. `core` is the engine's cohort-analyze core;
 * `isWithheld(props)` says a parcel is past a Protected county's detail limit (ADR 0015),
 * so its empty cells read "Withheld" rather than "—".
 */
export function buildTable(data, { core, labels = {}, isWithheld = () => false }) {
  // A missing value stays missing: Number(null) is 0, which showed "$0" per acre.
  const num = (v) => (v == null || v === '' ? NaN : Number(v));
  const withheldIds = new Set();
  const features = data.features.map((f) => {
    const p = f.properties || {};
    if (isWithheld(p)) withheldIds.add(String(f.id));
    const av = num(p.assessed_value), ac = num(p.gis_acres);
    // $/acre compares like any other field; it's derived for display, so it's added
    // here rather than in the pure engine core.
    const perAcre = !Number.isNaN(av) && !Number.isNaN(ac) && ac > 0 ? Math.round(av / ac) : null;
    return { id: f.id, properties: { ...p, av_per_acre: perAcre } };
  });
  const result = core({
    cohort: { selector: data.selector, features },
    fields: { columnLabel: 'pin', compareFields: COMPARE_FIELDS.map(({ key, label }) => ({ key, label })) },
    aggregators: ['compare'],
    source_id: 'assessment-roll',
  });
  const t = result.facts.compare;
  return {
    columns: t.columns.map((col) => ({ id: col.id, label: String(col.label || col.id) })),
    rows: t.rows.map((row) => ({
      field: row.field,
      label: row.label,
      differs: !!row.differs,
      cells: row.values.map((v, i) => {
        const col = t.columns[i];
        const withheld = v == null && !!col && withheldIds.has(String(col.id));
        return { text: withheld ? 'Withheld' : formatValue(row.field, v, labels), withheld };
      }),
    })),
  };
}
