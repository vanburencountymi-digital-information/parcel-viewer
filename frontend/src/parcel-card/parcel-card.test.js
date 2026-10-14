// The parcel card (DIC-2389 slice 3): the model, the chart, escaping of tax-roll values
// (DIC-1852), the feature mode and the bookmark star. The e2e suite checks it in the
// real panel (search-and-panel, data-access, explainers, bookmarks-and-share…).
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import popup from '../../../engine/popup.js';
import { PARCEL_POPUP, parcelPopupSource } from './config.js';
import { avHistoryChart, buildCard, displayPin } from './card.js';
import { avYear, createFormatters } from './formatters.js';
import ParcelCard from './ParcelCard.vue';
import { createParcelCardStore } from './store.js';

const EVIL = '<img src=x onerror=alert(1)>';
const LABELS = { propClass: { 401: 'Residential' }, schoolDist: { 80010: 'Paw Paw Public Schools' } };

const PARCEL = {
  id: 7, parcel_no: '80-14-014-015-00', municipality: 'Paw Paw Township',
  prop_street: '36771 PAW PAW RD', prop_city: 'PAW PAW', gis_acres: '0.5',
  prop_class: '401', school_dist: '80010', source: 'migration',
  owner_name: 'NEARN JAMES', owner_street: '36771 PAW PAW RD', owner_city: 'PAW PAW', owner_state: 'MI', owner_zip: '49079',
  assessed_value: '39300', prev_assessed_value: '39300', taxable_value: '26165', prev_taxable_value: null,
  assessed_value_yr0: '39300', assessed_value_yr1: '39300', assessed_value_yr2: '', assessed_value_yr3: '31000', assessed_value_yr4: '28000',
  homestead: '100', legal_description: 'BEG ON E L OF SW 1/4',
};

function deps({ areaUnits = 'acres', withheld = false, bookmarked = false } = {}) {
  return {
    popup,
    source: parcelPopupSource(null),
    labels: LABELS,
    formatters: createFormatters({ labels: LABELS, areaUnits: () => areaUnits, formatPoint: () => '42.2°N 85.9°W' }),
    rollYear: () => 2026,
    isWithheld: () => withheld,
    isBookmarked: () => bookmarked,
  };
}

const card = (props = PARCEL, opts) => buildCard({ pin: 'K-1', props, geometry: null }, deps(opts));

describe('formatters', () => {
  it('turn blank or non-numeric history years into null', () => {
    expect([avYear('12'), avYear(''), avYear(null), avYear('x')]).toEqual([12, null, null, null]);
  });
});

describe('the card model', () => {
  it('formats the Parcel and Owner sections, "—" for nothing on record', () => {
    const c = card();
    const rows = Object.fromEntries(c.sections.flatMap((s) => s.rows).map((r) => [r.label, r.value]));
    expect(c.displayPin).toBe('80-14-014-015-00');
    expect(rows).toMatchObject({
      Address: '36771 PAW PAW RD, PAW PAW',
      Area: '0.50 ac (21,780 sq ft)',
      Center: '42.2°N 85.9°W',
      Class: '401 – Residential',
      School: 'Paw Paw Public Schools',
      Mailing: '36771 PAW PAW RD, PAW PAW MI, 49079',
    });
    expect(rows.Geometry).toBeUndefined();     // "migration" is the default, so skipped
    expect(c.assessed.rows).toEqual([
      expect.objectContaining({ label: 'AV', current: '$39,300', prior: '$39,300' }),
      expect.objectContaining({ label: 'TV', current: '$26,165', prior: '—' }),
      expect.objectContaining({ label: 'TMV', current: '$78,600', prior: '$78,600' }),
    ]);
    expect(c.assessed.pre).toBe('100%');
    expect(c.taxDescription).toBe('BEG ON E L OF SW 1/4');
  });

  it('follows the area-units preference', () => {
    const area = card(PARCEL, { areaUnits: 'sqft' }).sections[0].rows.find((r) => r.label === 'Area');
    expect(area.value).toBe('21,780 sq ft');
  });

  it('marks withheld details and the bookmark star', () => {
    const c = card(PARCEL, { withheld: true, bookmarked: true });
    expect(c.withheld).toBe(true);
    expect(c.bookmarked).toBe(true);
  });

  it('uses a manifest popup only when it has rich sections', () => {
    expect(parcelPopupSource({ popup: { sections: ['Parcel'] } }).popup).toBe(PARCEL_POPUP);
    const rich = { popup: { sections: [{ title: 'Parcel', fields: [] }] } };
    expect(parcelPopupSource(rich).popup).toBe(rich.popup);
  });

  it('shows the parcel number, else the selection key', () => {
    expect(displayPin('K-1', { pin: 'P' })).toBe('P');
    expect(displayPin('K-1', {})).toBe('K-1');
  });
});

describe('the AV history chart', () => {
  it('draws oldest to newest, ending at the roll year, with a gap for a missing year', () => {
    const chart = avHistoryChart([40000, 30000, null, 20000, 10000], 2026);
    expect(chart.columns.map((c) => c.year)).toEqual([2022, 2023, 2024, 2025, 2026]);
    expect(chart.columns.map((c) => c.bar && c.bar.label)).toEqual(['$10k', '$20k', null, '$30k', '$40k']);
    expect(Number(chart.columns[4].bar.h)).toBeGreaterThan(Number(chart.columns[0].bar.h));
  });

  it('has no chart without values, and no 0/0 for an all-zero history', () => {
    expect(avHistoryChart([null, null, null, null, null], 2026)).toBeNull();
    const zero = avHistoryChart([0, 0, 0, 0, 0], 2026);
    expect(zero.columns.every((c) => c.bar.h === '3.0')).toBe(true);
  });
});

function mountCard({ env = {}, props = PARCEL, pin = 'K-1' } = {}) {
  const store = createParcelCardStore({
    isDark: () => false,
    selectedParcel: () => ({ id: 7 }),
    toggleBookmark: () => true,
    cardDeps: () => deps(),
    ...env,
  });
  store.show(pin, props, null);
  return { store, w: mount(ParcelCard, { props: { store } }) };
}

describe('the component', () => {
  it('renders hostile tax-roll values as text, never markup (DIC-1852)', () => {
    const evil = {
      owner_name: 'SMITH & JONES ' + EVIL, owner_street: EVIL, prop_street: '123 MAIN ' + EVIL,
      municipality: EVIL, prop_class: EVIL, school_dist: EVIL, legal_description: EVIL, source: EVIL,
    };
    const { w } = mountCard({ props: evil, pin: '"><img src=x onerror=alert(1)>' });
    expect(w.find('img').exists()).toBe(false);
    expect(w.text()).toContain('SMITH & JONES ' + EVIL);
    expect(w.get('[data-ptool="packet"]').attributes('data-pin')).toBe('"><img src=x onerror=alert(1)>');
  });

  it('shows the withheld note, the chart and the actions', () => {
    const { w } = mountCard({ env: { cardDeps: () => deps({ withheld: true }) } });
    expect(w.find('[data-testid="parcel-details-withheld"]').exists()).toBe(true);
    expect(w.get('[data-testid="parcel-info-pin"]').text()).toBe('80-14-014-015-00');
    expect(w.findAll('svg[aria-label="AV history chart"] rect').length).toBe(4);   // one year missing
    expect(w.findAll('.pv-ptool').map((b) => b.attributes('data-ptool'))).toEqual(['streetview', 'packet', 'compare', 'profile']);
  });

  it('the star toggles the bookmark of the parcel on show', async () => {
    const toggleBookmark = vi.fn(() => true);
    const { w } = mountCard({ env: { toggleBookmark } });
    const star = w.get('.pv-bm-toggle');
    expect(star.attributes('aria-pressed')).toBe('false');
    await star.trigger('click');
    expect(toggleBookmark).toHaveBeenCalledWith({ id: 7 });
    expect(star.attributes('aria-pressed')).toBe('true');
    expect(star.text()).toContain('Bookmarked');
  });

  it("shows another layer's feature in place of the card, then the next parcel again", async () => {
    const { store, w } = mountCard();
    store.showFeature('<div class="parcel-info-row">Road 42</div>');
    await nextTick();
    expect(w.text()).toBe('Road 42');
    store.show('K-2', PARCEL, null);
    await nextTick();
    expect(w.find('[data-testid="parcel-info-pin"]').exists()).toBe(true);
  });
});
