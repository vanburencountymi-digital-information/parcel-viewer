// The Parcel Packet window (DIC-2389; was admin-menu.js's openPacket). The e2e suite opens
// it through the parcel panel (parcel-packet.spec.js).
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPacket } from '../index.js';
import PacketExplain from './PacketExplain.vue';
import PacketLedger from './PacketLedger.vue';
import PacketWindow from './PacketWindow.vue';
import { LEDGER, answerFor, ledgerNewestFirst, ledgerX, packetDate, packetFacts } from './packet-data.js';

describe('packet data', () => {
  it("the parcel's facts, with placeholders, and a withheld owner said as such", () => {
    expect(packetFacts({ pin: 'P-1', owner_name: 'SMITH', site_address: '1 MAIN', municipality: 'Almena', acres: 2.345 }))
      .toEqual({ pin: 'P-1', owner: 'SMITH', address: '1 MAIN', muni: 'Almena', acres: '2.35' });
    expect(packetFacts({})).toEqual({ pin: '—', owner: 'Owner on record', address: 'Address on file', muni: 'Van Buren County', acres: '—' });
    expect(packetFacts({}, { withheld: true }).owner).toBe('Withheld today (daily detail limit)');
    expect(packetDate(new Date(2026, 9, 16))).toBe('October 16, 2026');
  });

  it('answers a suggested question in any case, else says the live Packet would', () => {
    expect(answerFor('env', '  IS THIS A GOOD SEPTIC SITE? ')).toMatch(/^Likely yes\./);
    expect(answerFor('env', 'Can I keep goats?')).toMatch(/^That's exactly what the live Packet answers/);
    expect(answerFor('nope', 'anything')).toMatch(/^That's exactly what the live Packet answers/);
  });

  it('the ledger, newest first, on a 1871–2026 ribbon', () => {
    const years = ledgerNewestFirst().map((i) => LEDGER[i].y);
    expect(years).toEqual([...years].sort((a, b) => b - a));
    expect(years[0]).toBe(2025);
    expect([ledgerX(1871), ledgerX(2026)]).toEqual([16, 664]);
  });
});

describe('PacketExplain', () => {
  it('asks a suggested question, thinks, then answers', async () => {
    vi.useFakeTimers();
    const w = mount(PacketExplain, { props: { qaKey: 'assess' }, slots: { default: 'Values <b>explained</b>.' } });
    expect(w.get('.pp-explain').attributes('data-qa')).toBe('assess');
    expect(w.find('p b').text()).toBe('explained');
    await w.get('.pp-qa-chip').trigger('click');
    expect(w.get('.pp-qa-q').text()).toBe('Why is taxable value lower than assessed?');
    expect(w.find('[aria-label="Thinking"]').exists()).toBe(true);
    vi.advanceTimersByTime(550);
    await flushPromises();
    expect(w.get('.pp-qa-a').text()).toMatch(/^Because of Michigan's Proposal A cap\./);
    vi.useRealTimers();
  });

  it('answers what is typed, clears the box, and ignores a blank question', async () => {
    const w = mount(PacketExplain, { props: { qaKey: 'docs', delay: 0 } });
    const input = w.get('input[aria-label="Ask a question about this section"]');
    expect(input.attributes('placeholder')).toBe('Ask about documents or boundaries…');
    await input.setValue('   ');
    await w.get('form').trigger('submit');
    expect(w.findAll('.pp-qa-q')).toHaveLength(0);
    await input.setValue('Where are the property corners?');
    await w.get('form').trigger('submit');
    expect(input.element.value).toBe('');
    await new Promise((r) => setTimeout(r, 0));
    expect(w.get('.pp-qa-a').text()).toMatch(/^The County Surveyor's field notes/);
  });
});

describe('PacketLedger', () => {
  const visible = (w) => w.findAll('.pp-levent').filter((r) => r.element.style.display !== 'none');

  it('lists every event newest first; opening one explains it and shows the parcel as of then', async () => {
    const w = mount(PacketLedger);
    const rows = w.findAll('.pp-levent');
    expect(rows).toHaveLength(LEDGER.length);
    expect(rows[0].get('.pp-lyear').text()).toBe('2025');
    expect(w.get('.pp-linset-cap').text()).toMatch(/^Select an event/);
    const deed = rows.find((r) => r.text().includes('Conveyed to Smith, John & Jane'));
    await deed.get('.pp-levent-head').trigger('click');
    expect(deed.get('.pp-levent-head').attributes('aria-expanded')).toBe('true');
    expect(deed.get('.pp-lexplain').element.style.display).toBe('');
    expect(deed.classes()).toContain('is-sel');
    expect(w.get('.pp-linset-cap').text()).toBe('Parcel as of 2014 — Conveyed to Smith, John & Jane. preview');
    await deed.get('.pp-levent-head').trigger('click');
    expect(deed.get('.pp-lexplain').element.style.display).toBe('none');
  });

  it('a ribbon tick selects its event', async () => {
    const w = mount(PacketLedger);
    await w.findAll('.pp-ltick')[2].trigger('click');   // 1968, inferred
    expect(w.get('.pp-linset-cap').text()).toMatch(/^Parcel as of 1968 — Dwelling constructed/);
    expect(w.get('.pp-levent.is-sel').attributes('data-li')).toBe('2');
  });

  it('filters by kind; All turns every kind on, then off', async () => {
    const w = mount(PacketLedger);
    await w.get('.pp-lchip[data-cat="ownership"]').trigger('click');
    expect(visible(w)).toHaveLength(LEDGER.length - 2);
    expect(w.get('.pp-lchip[data-cat="ownership"]').classes()).toContain('is-off');
    await w.get('.pp-lchip[data-cat="all"]').trigger('click');
    expect(visible(w)).toHaveLength(LEDGER.length);
    await w.get('.pp-lchip[data-cat="all"]').trigger('click');
    expect(visible(w)).toHaveLength(0);
    expect(w.get('.pp-lchip[data-cat="all"]').classes()).toContain('is-off');
  });
});

describe('PacketWindow', () => {
  const parcel = { id: 1, pin: '80-01-001', owner_name: 'SMITH JOHN', site_address: '1 MAIN ST', municipality: 'Almena Twp', acres: 2.3 };

  it('says to pick a parcel when none is selected', () => {
    const w = mount(PacketWindow, { props: { parcel: null } });
    expect(w.text()).toBe('Select a parcel first, then open its Packet.');
  });

  it("shows the parcel's own facts and the date", () => {
    const w = mount(PacketWindow, { props: { parcel, now: new Date(2026, 9, 16) } });
    expect(w.get('.pp-hero-addr').text()).toBe('1 MAIN ST');
    expect(w.get('.pp-hero-sub').text()).toBe('80-01-001 · Almena Twp · SMITH JOHN');
    expect(w.get('.pp-hero-meta').text()).toBe('Comprehensive property intelligence · generated October 16, 2026');
    expect(w.get('.pp-fact-v').text()).toBe('2.30 ac');
    expect(w.findAll('.pp-section-h').map((h) => h.text())).toEqual(['Parcel Ledger', 'Assessment & Tax', 'Ownership',
      'Tax Description', 'Environmental', '70-Year Aerial History', 'Documents & Survey Notes']);
    expect(w.findAll('.pp-explain').map((e) => e.attributes('data-qa'))).toEqual(['ledger', 'assess', 'owner', 'taxdesc', 'env', 'aerial', 'docs']);
  });

  it('Share / Embed toggles, and Copy copies and says so briefly', async () => {
    vi.useFakeTimers();
    const copy = vi.fn(async () => {});
    const w = mount(PacketWindow, { props: { parcel, copy } });
    const btn = w.get('#pp-share-btn');
    expect(w.get('#pp-share').attributes('hidden')).toBeDefined();
    await btn.trigger('click');
    expect(btn.attributes('aria-expanded')).toBe('true');
    expect(w.get('#pp-share').attributes('hidden')).toBeUndefined();
    expect(w.get('input.pp-share-in').element.value).toBe('https://packet.dicelabs.org/p/80-01-001?s=ab12cd');
    await w.get('[data-copy="embed"]').trigger('click');
    expect(copy).toHaveBeenCalledWith('<iframe src="https://packet.dicelabs.org/embed/80-01-001?k=YOUR_API_KEY" width="100%" height="640" style="border:0"></iframe>');
    expect(w.get('[data-copy="embed"]').text()).toBe('Copied ✓');
    expect(w.get('[data-copy="link"]').text()).toBe('Copy');
    vi.advanceTimersByTime(1400);
    await flushPromises();
    expect(w.get('[data-copy="embed"]').text()).toBe('Copy');
    vi.useRealTimers();
  });

  it('Monitor is on the roadmap', async () => {
    const w = mount(PacketWindow, { props: { parcel } });
    await w.get('#pp-monitor-btn').trigger('click');
    expect(w.get('#pp-monitor-btn').text()).toBe('On the roadmap ✓');
    expect(w.get('#pp-monitor-btn').attributes('disabled')).toBeDefined();
  });
});

describe('openPacket', () => {
  afterEach(() => { delete globalThis.PS_STATE; delete globalThis.PV_ACCESS; });

  it('with no parcel: the plain window that says so', () => {
    const modal = { open: vi.fn() };
    openPacket(modal);
    expect(modal.open).toHaveBeenCalledWith('Parcel Packet', { component: PacketWindow, props: { parcel: null } });
  });

  it('with a parcel: the wide, flush window, the owner withheld past the daily limit', () => {
    globalThis.PS_STATE = { parcel: { id: 1, pin: 'P', owner_name: null } };
    globalThis.PV_ACCESS = { getState: () => ({ withheld: true }) };
    const modal = { open: vi.fn() };
    openPacket(modal);
    const [, body, , opts] = modal.open.mock.calls[0];
    expect([body.props.withheld, opts]).toEqual([true, { wide: true, flush: true }]);
  });
});
