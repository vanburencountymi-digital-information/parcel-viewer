// Select by attribute: which parcels in the viewport index match a field/operator/value
// filter. Pure, so Vitest checks it directly.

export const OPERATORS = [
  { value: 'eq', label: 'equals' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: 'greater than' },
  { value: 'lt', label: 'less than' },
];

/** The fields to filter on: the index's property names, labelled with spaces for underscores. */
export function filterFields(parcels) {
  const first = parcels && parcels[0];
  return first ? Object.keys(first.properties).map((key) => ({ key, label: key.replace(/_/g, ' ') })) : [];
}

/**
 * The parcels whose `field` satisfies `op` against `value`: equals and contains compare
 * text without case; greater and less than compare numbers. No field or value: none.
 */
export function matchParcels(parcels, { field, op, value }) {
  const val = String(value || '').trim().toLowerCase();
  if (!field || !val) return [];
  const qn = parseFloat(val);
  return parcels.filter((f) => {
    const raw = f.properties[field];
    if (raw == null) return false;
    const v = String(raw).toLowerCase();
    const n = parseFloat(raw);
    switch (op) {
      case 'eq': return v === val;
      case 'contains': return v.includes(val);
      case 'gt': return !Number.isNaN(n) && !Number.isNaN(qn) && n > qn;
      case 'lt': return !Number.isNaN(n) && !Number.isNaN(qn) && n < qn;
      default: return false;
    }
  });
}
