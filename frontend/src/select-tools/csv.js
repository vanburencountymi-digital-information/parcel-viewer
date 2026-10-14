// The selection as CSV: one column per property any selected parcel has, one row per
// parcel. Pure, so Vitest checks it directly.

// Text starting with = + - @ (or tab/CR) is run as a formula when the CSV is opened in
// Excel/Sheets, so prefix it with ' (OWASP CSV-injection guidance). Numbers, including
// negatives, pass through unchanged.
export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text for `records` (each a parcel's properties), header first. */
export function selectionCsv(records) {
  const fields = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const rows = [fields.map(csvCell).join(',')];
  for (const r of records) rows.push(fields.map((f) => csvCell(r[f])).join(','));
  return rows.join('\n');
}
