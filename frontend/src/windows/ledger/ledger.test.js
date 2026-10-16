// The live Parcel Ledger (DIC-2389; was pv-ledger.js, whose render tests lived in
// engine/test/ledger.render.test.js). Through the REAL engine registry and core.
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../engine/test/fixtures/ledger-events.json';
import { installViewerHooks } from '../../../../engine/window-hooks.js';
import LedgerWindow from './LedgerWindow.vue';
import { fetchLedger, ribbon, surveyLine } from './ledger.js';

const hooks = installViewerHooks({});
const core = hooks.ISV_LEDGER_CORE;

describe('fetchLedger', () => {
  it('runs the history endpoint through ISV.invoke to facts and provenance', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => fixture }));
    const res = await fetchLedger(4021, { base: '/api', fetchFn, isv: hooks.ISV });
    expect(fetchFn).toHaveBeenCalledWith('/api/parcel/4021/history', { cache: 'no-cache' });
    expect(res.facts).toEqual(core.core(fixture).facts);
    expect(res.provenance.length).toBeGreaterThan(0);
  });

  it('without the registry, straight to the core; an HTTP error rejects', async () => {
    const ok = vi.fn(async () => ({ ok: true, json: async () => fixture }));
    expect((await fetchLedger(1, { base: '/api', fetchFn: ok, core })).facts).toEqual(core.core(fixture).facts);
    const bad = vi.fn(async () => ({ ok: false, status: 502 }));
    await expect(fetchLedger(1, { base: '/api', fetchFn: bad, core })).rejects.toThrow('HTTP 502');
    await expect(fetchLedger(null, { base: '/api', fetchFn: ok })).rejects.toThrow('no parcel id');
  });
});

describe('LedgerWindow', () => {
  const facts = core.core(fixture).facts;

  it('renders live events: years, categories, recorded vs inferred, survey quality', async () => {
    const w = mount(LedgerWindow, { props: { load: async () => ({ facts }), core } });
    expect(w.get('[role="status"]').text()).toBe('Loading this parcel’s ledger…');
    await flushPromises();
    const text = w.text();
    expect(text).toContain('2021');
    expect(text).toContain('Boundary survey');
    expect(text).toContain('Survey');                             // category label
    expect(w.find('a.pp-lsrc').text()).toContain('L2021-0473 Recorded Survey');   // recorded → its source
    expect(text).toContain('Bowditch-adjusted');                  // survey-quality signal
    expect(text).toContain('No document of record (inferred)');   // the honest "none" state (§6.4)
    expect(w.find('.pp-ldot--inf').exists()).toBe(true);
  });

  it('a row expands to its story', async () => {
    const w = mount(LedgerWindow, { props: { load: async () => ({ facts }), core } });
    await flushPromises();
    const head = w.get('.pp-levent-head');
    expect(w.get('.pp-lexplain').element.style.display).toBe('none');
    await head.trigger('click');
    expect(head.attributes('aria-expanded')).toBe('true');
    expect(w.get('.pp-lexplain').element.style.display).toBe('');
  });

  it('an empty ledger is a clean message; a failed one says so', async () => {
    const empty = mount(LedgerWindow, { props: { load: async () => core.core({ events: [] }), core } });
    await flushPromises();
    expect(empty.text()).toContain('No recorded events for this parcel yet.');
    const failed = mount(LedgerWindow, { props: { load: async () => { throw new Error('HTTP 500'); }, core } });
    await flushPromises();
    expect(failed.text()).toBe('Couldn’t load this parcel’s ledger.HTTP 500');
  });

  it('the ribbon spans the events; one year has none', () => {
    expect(ribbon({ span: { from: 2000, to: 2000 }, events: [] })).toBe(null);
    const t = ribbon({ span: { from: 2000, to: 2009 }, events: [{ year: 2000, category: 'tax', recorded: true }, { year: null }] });
    expect(t).toEqual([{ x: 16, color: '#b58d4a', recorded: true }]);
    expect(surveyLine({ closure_error: 0.02, precision_ratio: 15000 })).toBe('closure 0.02 ft · 1:15000');
  });
});
