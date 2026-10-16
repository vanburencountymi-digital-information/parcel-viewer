// The explainers' print / Download HTML document (was pv-explain.js's DOC_TPL). A
// standalone page with its own styles: it doesn't see viewer.css. Everything from the
// record or the model is escaped.
import { figureRows, historyChart, paragraphs, topicMeta } from './explain.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = '*{box-sizing:border-box}body{font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;margin:0;padding:24px;}'
  + '.doc{max-width:760px;margin:0 auto;}'
  + '.dh{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #A3473B;padding-bottom:8px;margin-bottom:16px;}'
  + '.dh-b{font-weight:700;color:#A3473B;font-size:16px;}.dh-s{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;}'
  + 'h1{font-size:20px;margin:0 0 14px;}h3{font-size:14px;margin:18px 0 4px;color:#A3473B;}'
  + 'table{width:100%;border-collapse:collapse;font-size:13.5px;margin-bottom:8px;}th{text-align:left;width:46%;color:#6b7280;font-weight:600;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;}td{padding:6px 8px;border-bottom:1px solid #eee;}'
  + 'dt{font-weight:700;margin-top:6px;}dd{margin:0 0 4px;color:#4b5563;}'
  + '.cite{color:#6b7280;font-size:12px;}.foot{margin-top:20px;font-size:11px;color:#9ca3af;}'
  + '@media print{body{padding:0;}a{color:inherit;text-decoration:none;}}';

/** The chart as an SVG string, in print-safe (light) colours. */
export function historySvg(facts) {
  const c = historyChart(facts);
  if (!c) return '';
  const k = c.colors;
  const bars = c.bars.map((b) => {
    const year = `<text x="${b.cx}" y="${c.yearY}" text-anchor="middle" font-size="10" fill="${k.year}">${b.year}</text>`;
    if (!b.bar) return year;
    return `<rect x="${b.bar.x}" y="${b.bar.y}" width="${b.bar.w}" height="${b.bar.h}" rx="2" fill="${b.bar.current ? k.current : 'url(#xp-av-grad)'}"/>`
      + `<text x="${b.cx}" y="${b.labelY}" text-anchor="middle" font-size="10" font-weight="600" fill="${k.value}">${b.label}</text>${year}`;
  }).join('');
  return `<svg viewBox="0 0 ${c.W} ${c.H}" style="width:100%;height:auto;display:block" role="img" aria-label="Five-year assessed value history, oldest to newest">`
    + `<defs><linearGradient id="xp-av-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${k.top}"/><stop offset="100%" stop-color="${k.bottom}"/></linearGradient></defs>`
    + `${bars}</svg>`;
}

const parasHtml = (text) => paragraphs(text).map((lines) => `<p>${lines.map(esc).join('<br>')}</p>`).join('');
const statuteHtml = (list) => list.map((s) => `<p><strong>${esc(s.name)}</strong> <span class="cite">${esc(s.citation)}</span><br>${esc(s.plain)}</p>`).join('');

function pinBreakdownHtml(b) {
  if (!b || !b.parts || !b.parts.length) return '';
  const rows = b.parts.map((p) => '<tr><td style="font-family:monospace;font-weight:700;white-space:nowrap;padding:4px 12px 4px 0;vertical-align:top">'
    + `${esc(p.value)}</td><td style="padding:4px 0"><strong>${esc(p.name)}</strong>`
    + `${p.description ? `<br><span class="cite">${esc(p.description)}</span>` : ''}</td></tr>`).join('');
  return `<h3>How to read the parcel number</h3>${b.intro ? `<p>${esc(b.intro)}</p>` : ''}<table>${rows}</table>`;
}

function dateText(now) {
  try { return now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return ''; }
}

/** The whole document. result is loadExplainer's { facts, statutes, explanation }. */
export function docHtml(topic, { facts, statutes, explanation }, { county = 'County', now = new Date() } = {}) {
  const meta = topicMeta(topic);
  let body = '';
  if (topic === 'tax_description') {
    if (facts.description_text) {
      body += `<div style="border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:13px;white-space:pre-wrap">${esc(facts.description_text)}</div>`;
    }
    if (facts.type_label) body += `<p class="cite">Detected type: ${esc(facts.type_label)}${facts.type_note ? ` — ${esc(facts.type_note)}` : ''}</p>`;
    body += pinBreakdownHtml(facts.pin_breakdown);
  } else {
    body += `<table>${figureRows(facts).map((r) => `<tr><th>${esc(r.label)}</th><td>${esc(r.value)}</td></tr>`).join('')}</table>`;
    const svg = historySvg(facts);
    if (svg) body += `<div style="margin:4px 0 12px">${svg}</div>`;
  }
  if (explanation) {
    if (explanation.summary) body += `<p>${esc(explanation.summary)}</p>`;
    body += (explanation.sections || []).map((s) => `<h3>${esc(s.heading)}</h3><div>${parasHtml(s.body)}</div>`).join('');
    if ((explanation.statutes || []).length) body += `<h3>Michigan law</h3>${statuteHtml(explanation.statutes)}`;
    if (explanation.disclaimer) body += `<p class="cite">${esc(explanation.disclaimer)}</p>`;
  } else if ((statutes || []).length) {
    body += `<h3>Michigan law</h3>${statuteHtml(statutes)}`;   // AI-off print parity
  }
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + `<title>${esc(meta.docSubtitle)} — Parcel ${esc(facts.pin)}</title><style>${STYLE}</style></head><body><div class="doc">`
    + `<header class="dh"><span class="dh-b">${esc(county)}</span><span class="dh-s">${esc(meta.docSubtitle)}</span></header>`
    + `<h1>Parcel ${esc(facts.pin)}</h1>${body}`
    + `<footer class="foot">Generated ${esc(dateText(now))} · ${esc(county)} Parcel Viewer · Educational use only.</footer>`
    + '</div></body></html>';
}
