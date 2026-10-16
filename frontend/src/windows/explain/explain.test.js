// The per-parcel explainers (DIC-2389; were pv-explain.js, whose render tests lived in
// engine/test/explainer.render.test.js). Facts come from the REAL engine core and statute
// corpus, as on the page; the e2e suite covers them in the viewer (explainers.spec.js,
// data-access.spec.js).
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import core from '../../../../engine/capabilities/explainer.core.js';
import corpus from '../../../../engine/data/mi-tax-statutes.json';
import county from '../../../../engine/test/fixtures/county-labels.json';
import record from '../../../../engine/test/fixtures/parcel-assessment.json';
import { openExplainer } from '../index.js';
import AssessInfoWindow from './AssessInfoWindow.vue';
import ExplainerWindow from './ExplainerWindow.vue';
import PinBreakdown from './PinBreakdown.vue';
import TaxInfoWindow from './TaxInfoWindow.vue';
import { docHtml, historySvg } from './explain-doc.js';
import { AI_OFF_NOTE, aiState, docFileName, historyChart, loadExplainer, resetStatutesCache, topicMeta } from './explain.js';

const STATUTES = corpus.statutes;
const facts = () => core.buildAssessmentFacts(record, { labels: county.labels, currentYear: 2026 });
const taxFacts = (p = {}) => core.buildTaxDescriptionFacts({ ...record, ...p }, { parcelNumber: county.parcelNumber });
const ready = (result) => async () => result;
const mountWindow = async (props) => {
  const w = mount(ExplainerWindow, { props: { topic: 'assessment', ...props } });
  await flushPromises();
  return w;
};

describe('aiState', () => {
  it('off when the visitor turned it off; down when on but unreachable; else on', () => {
    expect(aiState({ aiMode: { isOn: () => false, isEffective: () => false } })).toBe('off');
    expect(aiState({ aiMode: { isOn: () => true, isEffective: () => false } })).toBe('down');
    expect(aiState({ aiMode: { isOn: () => true, isEffective: () => true } })).toBe('on');
    expect(aiState({ prefs: { getAiMode: () => 'off' } })).toBe('off');
    expect(aiState({ prefs: { getAiMode: () => 'on' } })).toBe('on');
    expect(aiState({})).toBe('on');
    expect(aiState({ prefs: { aiMode: 'off' } })).toBe('down');   // the legacy pref
  });
});

describe('loadExplainer', () => {
  const feature = { properties: record };
  let calls;
  function fetchFrom(explain) {
    calls = [];
    return vi.fn(async (url, opts) => {
      calls.push(url);
      if (url.endsWith('/explain')) return explain(opts);
      if (url.includes('mi-tax-statutes')) return { ok: true, json: async () => corpus };
      if (url.includes('/parcel/')) return { ok: true, json: async () => feature };
      return { ok: false, status: 404 };
    });
  }
  const deps = (over) => ({ core, county, apiBase: '/api', aiBase: '/mb', ...over });
  beforeEach(resetStatutesCache);

  it('AI off: the facts and statutes, says it is off, and never calls the AI', async () => {
    const fetchFn = fetchFrom(() => { throw new Error('called'); });
    const res = await loadExplainer('assessment', { id: 7 }, deps({ fetchFn, ai: 'off' }));
    expect(res.facts.assessed_value).toBe(98000);
    expect(res.statutes.length).toBeGreaterThan(0);
    expect([res.explanation, res.note]).toEqual([null, AI_OFF_NOTE]);
    expect(calls).toEqual(['/api/parcel/7', '/engine/data/mi-tax-statutes.json']);
  });

  it('AI on but known down: says it could not be reached, without calling it', async () => {
    const fetchFn = fetchFrom(() => { throw new Error('called'); });
    const res = await loadExplainer('assessment', { id: 7 }, deps({ fetchFn, ai: 'down' }));
    expect(res.note).toBe(topicMeta('assessment').fallbackTeaser);
    expect(calls.some((u) => u.endsWith('/explain'))).toBe(false);
  });

  it('AI on: the narration over the same facts; a failed call degrades to the facts', async () => {
    const explanation = { summary: 'S', sections: [] };
    let fetchFn = fetchFrom(async (opts) => {
      expect(JSON.parse(opts.body)).toMatchObject({ topic: 'assessment', facts: { assessed_value: 98000 } });
      return { ok: true, json: async () => ({ ok: true, explanation }) };
    });
    const on = await loadExplainer('assessment', { id: 7 }, deps({ fetchFn }));
    expect([on.explanation, on.note]).toEqual([explanation, '']);
    fetchFn = fetchFrom(async () => ({ ok: false, status: 503 }));
    const failed = await loadExplainer('assessment', { id: 7 }, deps({ fetchFn }));
    expect([failed.explanation, failed.note]).toEqual([null, topicMeta('assessment').fallbackTeaser]);
    expect(failed.facts).toEqual(on.facts);
  });

  it('an empty tax description is not narrated', async () => {
    const fetchFn = vi.fn(async (url) => {
      if (url.endsWith('/explain')) throw new Error('called');
      if (url.includes('mi-tax-statutes')) return { ok: true, json: async () => corpus };
      return { ok: true, json: async () => ({ properties: { ...record, legal_description: '', ps_legal_description: '' } }) };
    });
    const res = await loadExplainer('tax_description', { id: 7 }, deps({ fetchFn }));
    expect([res.facts.description_text, res.explanation]).toEqual(['', null]);
  });

  it('rejects with the HTTP status, or as withheld past the daily limit', async () => {
    const http500 = vi.fn(async (url) => (url.includes('/parcel/') ? { ok: false, status: 500 } : { ok: true, json: async () => corpus }));
    await expect(loadExplainer('assessment', { id: 7 }, deps({ fetchFn: http500 }))).rejects.toThrow('HTTP 500');
    const access = { note: vi.fn(), isWithheld: () => true };
    await expect(loadExplainer('assessment', { id: 7 }, deps({ fetchFn: fetchFrom(() => null), access })))
      .rejects.toMatchObject({ withheld: true });
    expect(access.note).toHaveBeenCalledWith(feature);
  });
});

describe('ExplainerWindow', () => {
  it('AI off: the recorded figures, the statutes as citation links, and the note', async () => {
    const w = await mountWindow({ load: ready({ facts: facts(), statutes: STATUTES, explanation: null, note: AI_OFF_NOTE }) });
    const figs = w.get('[role="group"][aria-label="Recorded figures"]');
    expect(figs.text()).toContain('$98,000');
    expect(w.text()).toContain('Michigan law');
    expect(w.text()).toMatch(/MCL 211\.27a/);
    const cite = w.get('[data-testid="cite-trigger"]');
    expect(cite.attributes('data-cite-source')).toBeTruthy();
    expect(w.findAll('a.pv-xp-stat-ext').every((a) => /^https?:\/\//.test(a.attributes('href')))).toBe(true);
    expect(w.find('a.pv-xp-stat-ext[href*="legislature.mi.gov"]').exists()).toBe(true);
    expect(w.text()).toContain('walkthrough is off');
    expect(w.text()).not.toContain('Assessing values every parcel for taxation');   // no prose AI-off
  });

  it('AI on: narration over the IDENTICAL figures, model text as text', async () => {
    const explanation = {
      summary: 'Your assessed value is $98,000.\n\nSecond <b>para</b>\nline two',
      sections: [{ heading: 'What these mean', body: 'Plain body.' }],
      glossary: [{ term: 'SEV', definition: 'State equalized value' }],
      statutes: [{ name: 'Proposal A', citation: 'MCL 211.27a(2)', plain: 'cap' }],
      disclaimer: 'Educational only.',
    };
    const on = await mountWindow({ load: ready({ facts: facts(), statutes: STATUTES, explanation, note: '' }) });
    const off = await mountWindow({ load: ready({ facts: facts(), statutes: STATUTES, explanation: null, note: AI_OFF_NOTE }) });
    const figs = (w) => w.get('[aria-label="Recorded figures"] table').text();
    expect(figs(on)).toBe(figs(off));
    const summary = on.get('[data-testid="pv-xp-summary"]');
    expect(summary.findAll('p')).toHaveLength(2);
    expect(summary.text()).toContain('Second <b>para</b>');
    expect(summary.find('b').exists()).toBe(false);
    expect(summary.findAll('br')).toHaveLength(1);
    expect(on.findAll('.pv-xp-h').map((h) => h.text())).toEqual(['What these mean', 'Key terms', 'Michigan law']);
    expect(on.text()).toContain('Educational only.');
    expect(off.text()).not.toContain('What these mean');
  });

  it('AI on but unreachable says so, never "walkthrough is off"', async () => {
    const w = await mountWindow({ load: ready({ facts: facts(), statutes: STATUTES, explanation: null, note: topicMeta('assessment').fallbackTeaser }) });
    expect(w.text()).toContain('$98,000');
    expect(w.text()).toMatch(/couldn.t be reached/);
    expect(w.text()).not.toContain('walkthrough is off');
  });

  it('the tax description: the recorded text, its type, and the parcel number in parts', async () => {
    const f = taxFacts({ legal_description: 'COM AT NW COR OF SEC 1; TH S 200 FT TO POB' });
    const w = await mountWindow({ topic: 'tax_description', load: ready({ facts: f, statutes: [], explanation: null, note: '' }) });
    const group = w.get('[role="group"][aria-label="Recorded tax description"]');
    expect(group.get('[data-testid="pv-xp-desc"]').text()).toBe(f.description_text);
    expect(group.get('.pv-badge').text()).toBe('Metes & bounds');
    expect(group.findAll('.pv-pin-row')).toHaveLength(f.pin_breakdown.parts.length);
    const empty = await mountWindow({ topic: 'tax_description', load: ready({ facts: taxFacts({ legal_description: '', ps_legal_description: '' }), statutes: [], explanation: null, note: '' }) });
    expect(empty.get('[data-testid="pv-xp-desc"]').text()).toBe('No tax description is on record for this parcel.');
  });

  it('loading, then withheld (with an http(s) dataset link only) or the error', async () => {
    let fail;
    const w = mount(ExplainerWindow, {
      props: { topic: 'tax_description', load: () => new Promise((_, r) => { fail = r; }), withheldDataUrl: () => 'https://county.example.org/data' },
    });
    expect(w.get('[role="status"]').text()).toBe('Loading this parcel’s tax description…');
    fail(Object.assign(new Error('details withheld'), { withheld: true }));
    await flushPromises();
    const note = w.get('[data-testid="explainer-details-withheld"]');
    expect(note.text()).toMatch(/^This parcel’s tax description details are withheld for the rest of today/);
    expect(note.get('a').attributes('href')).toBe('https://county.example.org/data');
    const bad = await mountWindow({ load: () => Promise.reject(Object.assign(new Error('w'), { withheld: true })), withheldDataUrl: () => 'javascript:alert(1)' });
    expect(bad.find('[data-testid="explainer-details-withheld"] a').exists()).toBe(false);
    const err = await mountWindow({ load: () => Promise.reject(new Error('HTTP 500')) });
    expect(err.text()).toBe('Couldn’t load this parcel’s property assessment.HTTP 500');
  });

  it('Print and Download HTML hand the document to PV_DOC', async () => {
    const result = { facts: facts(), statutes: STATUTES, explanation: null, note: AI_OFF_NOTE };
    const doc = { print: vi.fn(), downloadHtml: vi.fn() };
    const w = await mountWindow({ load: ready(result), doc, county: 'Van Buren County' });
    await w.get('[data-xp="print"]').trigger('click');
    await w.get('[data-xp="download"]').trigger('click');
    expect(doc.print.mock.calls[0][0]).toContain('<h1>Parcel 80-08-032-002-00</h1>');
    expect(doc.downloadHtml.mock.calls[0][1]).toBe('assessment-80-08-032-002-00.html');
  });
});

describe('the printed document', () => {
  it('AI off: the figures, the chart and the statutes; everything escaped', () => {
    const f = { ...facts(), pin: '80-<1>' };
    const html = docHtml('assessment', { facts: f, statutes: STATUTES, explanation: null }, { county: 'Van Buren County', now: new Date(2026, 9, 16) });
    expect(html).toContain('<title>Property Assessment — Parcel 80-&lt;1&gt;</title>');
    expect(html).toContain('<th>Assessed Value (AV)</th><td>$98,000</td>');
    expect(html).toContain('aria-label="Five-year assessed value history, oldest to newest"');
    expect(html).toMatch(/<h3>Michigan law<\/h3><p><strong>/);
    expect(html).toContain('Generated October 16, 2026 · Van Buren County Parcel Viewer');
    expect(docFileName('assessment', f)).toBe('assessment-80-_1_.html');
  });

  it('AI on: the narration, escaped; the tax description with its parcel-number table', () => {
    const on = docHtml('assessment', { facts: facts(), statutes: STATUTES, explanation: { summary: '<script>x</script>', sections: [{ heading: 'H', body: 'a\nb' }] } });
    expect(on).toContain('<p>&lt;script&gt;x&lt;/script&gt;</p>');
    expect(on).toContain('<h3>H</h3><div><p>a<br>b</p></div>');
    const tax = docHtml('tax_description', { facts: taxFacts({ legal_description: 'LOT 4 BLK 2 SMITH ADD' }), statutes: [], explanation: null });
    expect(tax).toContain('LOT 4 BLK 2 SMITH ADD');
    expect(tax).toContain('Detected type: Platted lot');
    expect(tax).toContain('<h3>How to read the parcel number</h3>');
  });
});

describe('the history chart', () => {
  it('needs two values; the current year is highlighted; dark has its own colours', () => {
    expect(historyChart({ assessed_value_history: [1, null, null] })).toBe(null);
    const c = historyChart({ assessed_value_history: [120000, 110000, 100000], roll_year: 2026 });
    expect(c.bars.map((b) => b.year)).toEqual([2024, 2025, 2026]);
    expect(c.bars.map((b) => b.bar.current)).toEqual([false, false, true]);
    expect(c.bars.map((b) => b.label)).toEqual(['$100k', '$110k', '$120k']);
    expect(historyChart({ assessed_value_history: [2, 1] }, { dark: true }).colors.current).toBe('#d4a862');
    expect(historySvg({ assessed_value_history: [2, 1] })).toMatch(/^<svg /);
  });
});

describe('PinBreakdown', () => {
  it('tints each part and marks parts past the configured segments as unmapped', () => {
    const breakdown = { separator: '-', intro: 'How to read it', parts: [{ value: '80', name: 'County' }, { value: 'X', name: 'Part 2', extra: true }] };
    const w = mount(PinBreakdown, { props: { breakdown } });
    expect(w.get('.pv-pin-line').text()).toBe('80-X');
    expect(w.findAll('.pv-pin-extra').map((e) => e.text())).toEqual(['unmapped']);
  });
});

describe('openExplainer', () => {
  afterEach(() => { delete globalThis.PS_STATE; });

  it('with no parcel: the general overview', () => {
    const modal = { open: vi.fn() };
    openExplainer('assessment', modal);
    openExplainer('tax_description', modal);
    expect(modal.open.mock.calls).toEqual([
      ['About Property Assessment', { component: AssessInfoWindow, props: {} }],
      ['About the Tax Description', { component: TaxInfoWindow, props: {} }],
    ]);
    expect(mount(AssessInfoWindow).findAll('.pv-help-h')).toHaveLength(6);
    expect(mount(TaxInfoWindow).text()).toContain('taxation purposes only');
  });

  it("with a parcel: its explainer, titled with the PIN", () => {
    globalThis.PS_STATE = { parcel: { id: 7, pin: '80-01' } };
    const modal = { open: vi.fn() };
    openExplainer('tax_description', modal);
    const [title, body] = modal.open.mock.calls[0];
    expect([title, body.component, body.props.topic]).toEqual(['Tax Description — 80-01', ExplainerWindow, 'tax_description']);
  });
});
