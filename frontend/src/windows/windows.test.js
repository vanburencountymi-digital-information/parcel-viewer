// The Help & tools windows moved to Vue (DIC-2389 slice 5): Help, What's New, About, Share,
// Bookmarks, Settings, Report a data error, Data Request, Print and Street View. The e2e suite opens them
// through the real menu (tool-windows, data-access, bookmarks-and-share, settings).
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AboutWindow from './AboutWindow.vue';
import BookmarksWindow from './BookmarksWindow.vue';
import DataRequestWindow from './DataRequestWindow.vue';
import HelpWindow from './HelpWindow.vue';
import PrintWindow from './PrintWindow.vue';
import ReportErrorWindow from './ReportErrorWindow.vue';
import SettingsWindow from './SettingsWindow.vue';
import ShareWindow from './ShareWindow.vue';
import StreetViewWindow from './StreetViewWindow.vue';
import WhatsNewWindow from './WhatsNewWindow.vue';
import { dataRequestUrl, mountWindows, openStreetView, sendReport } from './index.js';
import { embedUrl, heading, mapsUrl, resolveTarget } from './streetview.js';

const CHANGELOG = {
  version: '1.4.0',
  releases: [
    { version: '1.4.0', date: '2026-10-14', items: ['Vue <b>panels</b>'] },
    { version: '1.3.0', items: ['Django API'] },
  ],
};

describe('Help', () => {
  it('lists the topics and the keyboard keys', () => {
    const w = mount(HelpWindow);
    expect(w.findAll('.pv-help-h').map((h) => h.text())).toEqual(
      ['Find a parcel', 'Inspect a parcel', 'Overlays', 'Drawing & measure', 'MapBuddy A.I.', 'Keyboard navigation']);
    expect(w.findAll('.pv-kbd-list li')).toHaveLength(8);
  });
});

describe("What's New", () => {
  it('lists the releases, newest first, as text', async () => {
    const w = mount(WhatsNewWindow, { props: { load: async () => CHANGELOG } });
    expect(w.text()).toContain('Loading…');
    await flushPromises();
    expect(w.findAll('.pv-change-date').map((d) => d.text())).toEqual(['v1.4.0 · 2026-10-14', 'v1.3.0']);
    expect(w.find('b').exists()).toBe(false);
    expect(w.text()).toContain('Vue <b>panels</b>');
  });

  it('says so when the changelog is unavailable', async () => {
    const w = mount(WhatsNewWindow, { props: { load: async () => null } });
    await flushPromises();
    expect(w.get('.pv-empty').text()).toBe('Release notes are unavailable right now.');
  });
});

describe('About', () => {
  it('shows the county and the version', async () => {
    const w = mount(AboutWindow, { props: { county: { name: 'St. Joseph County', state: 'MI' }, load: async () => CHANGELOG } });
    await flushPromises();
    expect(w.get('.pv-modal-lead').text()).toBe('Parcel Viewer — St. Joseph County, MI');
    expect(w.get('#pv-app-version').text()).toBe('1.4.0 (preview)');
    expect(w.find('[data-testid="about-data-use"]').exists()).toBe(false);
  });

  it('for a Protected county, the data-use terms with http(s) links only', async () => {
    const access = { mode: 'protected', termsUrl: 'https://example.org/terms', dataUrl: 'javascript:alert(1)' };
    const w = mount(AboutWindow, { props: { access, load: async () => null } });
    await flushPromises();
    const row = w.get('[data-testid="about-data-use"]');
    expect(row.findAll('a').map((a) => a.attributes('href'))).toEqual(['https://example.org/terms']);
    expect(w.get('#pv-app-version').text()).toBe('0.x (preview)');
  });
});

describe('Share', () => {
  it('shows the link and copies it, saying so briefly', async () => {
    vi.useFakeTimers();
    const copy = vi.fn(async () => {});
    const w = mount(ShareWindow, { props: { url: 'https://example.org/demo/#p=1', copy } });
    expect(w.get('#pv-share-url').element.value).toBe('https://example.org/demo/#p=1');
    await w.get('#pv-share-copy').trigger('click');
    await flushPromises();
    expect(copy).toHaveBeenCalledWith('https://example.org/demo/#p=1');
    expect(w.get('#pv-share-copy').text()).toBe('Copied!');
    vi.advanceTimersByTime(1500);
    await flushPromises();
    expect(w.get('#pv-share-copy').text()).toBe('Copy');
    vi.useRealTimers();
  });
});

describe('Bookmarks', () => {
  function store(initial) {
    let list = initial.slice();
    return {
      list: () => list.slice(),
      has: (id) => list.some((b) => String(b.id) === String(id)),
      add: (p) => { list.push({ id: p.id, pin: p.pin }); },
      remove: (id) => { list = list.filter((b) => String(b.id) !== String(id)); },
    };
  }

  it('says how to bookmark when there are none', () => {
    const w = mount(BookmarksWindow, { props: { bookmarks: store([]), openParcel: () => {}, close: () => {} } });
    expect(w.get('.pv-empty').text()).toMatch(/^No bookmarks yet/);
    expect(w.find('#pv-bm-add').exists()).toBe(false);   // no parcel on show
  });

  it('bookmarks the parcel on show, then lists it', async () => {
    const w = mount(BookmarksWindow, {
      props: { bookmarks: store([]), parcel: { id: 7, pin: 'P-7' }, openParcel: () => {}, close: () => {} },
    });
    await w.get('#pv-bm-add').trigger('click');
    expect(w.findAll('.pv-bm-pin').map((p) => p.text())).toEqual(['P-7']);
    expect(w.text()).toContain('Current parcel (P-7) is bookmarked.');
  });

  it('opens a bookmark (closing the window) and removes one', async () => {
    const openParcel = vi.fn();
    const close = vi.fn();
    const bookmarks = store([{ id: 1, pin: 'P-1', owner: 'SMITH', address: '1 MAIN' }, { id: 2, pin: 'P-2' }]);
    const w = mount(BookmarksWindow, { props: { bookmarks, openParcel, close } });
    expect(w.get('.pv-bm-sub').text()).toBe('SMITH · 1 MAIN');
    await w.get('[aria-label="Remove bookmark P-2"]').trigger('click');
    expect(w.findAll('.pv-bm-item')).toHaveLength(1);
    await w.get('.pv-bm-open').trigger('click');
    expect(close).toHaveBeenCalled();
    expect(openParcel).toHaveBeenCalledWith(1);
  });
});

describe('Settings', () => {
  // Fake hooks that record what the window sets.
  function hooks() {
    const set = [];
    const rec = (name) => (...args) => set.push([name, ...args]);
    return {
      set,
      props: {
        prefs: {
          getAreaUnits: () => 'sqft', setAreaUnits: rec('area'),
          getBasemap: () => 'aerial', setBasemap: rec('basemap'),
          getCinematicOrbit: () => false, setCinematicOrbit: rec('orbit'),
          getMapReactions: () => 'full', setMapReactions: rec('reactions'),
          getMapMood: () => 'antique', setMapMood: rec('mood'),
        },
        coords: { getFormat: () => 'spc', setFormat: rec('coords') },
        hints: { isEnabled: () => false, setEnabled: rec('hints'), reset: rec('hints-reset') },
        scheme: { get: () => 'ocean', set: rec('scheme') },
        glass: { get: () => 0.8, set: rec('glass') },
        a11y: { getFlag: (n) => n === 'motion', setFlag: rec('flag'), getTextScale: () => 1.15, setTextScale: rec('ts') },
      },
    };
  }

  it('shows the saved preferences', () => {
    const w = mount(SettingsWindow, { props: hooks().props });
    expect(w.get('#pv-set-area').element.value).toBe('sqft');
    expect(w.get('#pv-set-coord').element.value).toBe('spc');
    expect(w.get('#pv-set-basemap').element.value).toBe('aerial');
    expect(w.get('#pv-set-glass').element.value).toBe('80');
    expect(w.get('[data-scheme="ocean"]').attributes('aria-pressed')).toBe('true');
    expect(w.get('[data-scheme="forest"]').attributes('aria-pressed')).toBe('false');
    expect(w.get('#pv-set-orbit').element.checked).toBe(false);
    expect(w.get('#pv-set-reactions').element.value).toBe('full');
    expect(w.get('#pv-set-mood').element.value).toBe('antique');
    expect(w.get('#pv-set-hints').element.checked).toBe(false);
    expect(w.get('#pv-a11y-ts').element.value).toBe('1.15');
    expect(w.findAll('.pv-a11y-chk').map((c) => [c.attributes('data-a'), c.element.checked])).toEqual(
      [['contrast', false], ['solid', false], ['font', false], ['motion', true]]);
    // Labels name their controls (the e2e suite finds them by label).
    expect(w.findAll('.pv-field-label').map((l) => l.text())).toEqual(['Area units', 'Coordinate format',
      'Default basemap', 'Panel glass', 'Color scheme', 'Search arrival', 'Map reactions', 'Map mood', 'Hints',
      'Text size', 'Language']);
  });

  it('defaults every control when no hook is on the page', () => {
    const w = mount(SettingsWindow);
    expect(w.get('#pv-set-area').element.value).toBe('acres');
    expect(w.get('#pv-set-coord').element.value).toBe('dd');
    expect(w.get('#pv-set-glass').element.value).toBe('62');
    expect(w.get('[data-scheme="terracotta"]').attributes('aria-pressed')).toBe('true');
    expect(w.get('#pv-set-orbit').element.checked).toBe(true);
    expect(w.get('#pv-set-hints').element.checked).toBe(true);
    expect(w.get('#pv-a11y-ts').element.value).toBe('1');
  });

  it('applies each change through its hook', async () => {
    const { set, props } = hooks();
    const w = mount(SettingsWindow, { props });
    await w.get('#pv-set-area').setValue('acres');
    await w.get('#pv-set-coord').setValue('dms');
    await w.get('#pv-set-basemap').setValue('dark');
    await w.get('#pv-set-glass').setValue('50');
    await w.get('[data-scheme="plum"]').trigger('click');
    await w.get('#pv-set-orbit').setValue(true);
    await w.get('#pv-set-reactions').setValue('off');
    await w.get('#pv-set-mood').setValue('none');
    await w.get('#pv-set-hints').setValue(true);
    await w.get('#pv-a11y-ts').setValue('1.3');
    await w.get('[data-a="contrast"]').setValue(true);
    expect(set).toEqual([['area', 'acres'], ['coords', 'dms'], ['basemap', 'dark'], ['glass', 0.5],
      ['scheme', 'plum'], ['orbit', true], ['reactions', 'off'], ['mood', 'none'], ['hints', true],
      ['ts', 1.3], ['flag', 'contrast', true]]);
    expect(w.get('[data-scheme="plum"]').attributes('aria-pressed')).toBe('true');
    expect(w.get('[data-scheme="ocean"]').attributes('aria-pressed')).toBe('false');
  });

  it("doesn't wrap several controls in one label (a click on its text would pick the first)", () => {
    const w = mount(SettingsWindow);
    const tags = Object.fromEntries(w.findAll('.pv-field').map((f) => [f.get('.pv-field-label').text(), f.element.tagName]));
    expect(tags).toMatchObject({ 'Area units': 'LABEL', 'Color scheme': 'DIV', 'Search arrival': 'DIV', Hints: 'DIV' });
  });

  it('Reset hints turns them back on', async () => {
    const { set, props } = hooks();
    const w = mount(SettingsWindow, { props });
    await w.get('#pv-hints-reset').trigger('click');
    expect(set).toEqual([['hints-reset']]);
    expect(w.get('#pv-set-hints').element.checked).toBe(true);
  });
});

describe('Report a data error', () => {
  const fill = async (w) => {
    await w.get('textarea[name="details"]').setValue('Wrong owner');
    await w.get('input[name="email"]').setValue('a@example.org');
  };

  it('fills in the selected parcel and sends the report, then thanks the visitor', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const close = vi.fn();
    const w = mount(ReportErrorWindow, { props: { pin: '80-01-001', send, close } });
    expect(w.get('input[name="pin"]').element.value).toBe('80-01-001');
    expect(w.find('.pv-field-opt').text()).toBe('(optional, for follow-up)');   // no "(if known)"
    await fill(w);
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(send).toHaveBeenCalledWith({ pin: '80-01-001', details: 'Wrong owner', email: 'a@example.org' });
    expect(w.get('.pv-form-success-title').text()).toBe('Report received!');
    await w.get('.pv-form-success [data-close]').trigger('click');
    expect(close).toHaveBeenCalled();
  });

  it('does not send without the details', async () => {
    const send = vi.fn();
    const w = mount(ReportErrorWindow, { props: { send, close: () => {} } });
    expect(w.findAll('.pv-field-opt').map((o) => o.text())).toEqual(['(if known)', '(optional, for follow-up)']);
    await w.get('form').trigger('submit');
    expect(send).not.toHaveBeenCalled();
  });

  it('says so when sending fails, and when there were too many reports', async () => {
    let fail = Object.assign(new Error('HTTP 500'), { status: 500 });
    const send = vi.fn(async () => { throw fail; });
    const w = mount(ReportErrorWindow, { props: { send, close: () => {} } });
    await fill(w);
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(w.get('[role="alert"]').text()).toBe('Sorry — couldn’t send your report just now. Please try again.');
    expect(w.get('button[type="submit"]').text()).toBe('Send report');
    expect(w.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
    fail = Object.assign(new Error('HTTP 429'), { status: 429 });
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(w.get('[role="alert"]').text()).toMatch(/^You’ve sent several reports recently/);
  });

  it('says Sending… while the report is on its way', async () => {
    let done;
    const send = () => new Promise((r) => { done = r; });
    const w = mount(ReportErrorWindow, { props: { send, close: () => {} } });
    await fill(w);
    await w.get('form').trigger('submit');
    expect(w.get('button[type="submit"]').text()).toBe('Sending…');
    expect(w.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    done({});
    await flushPromises();
    expect(w.find('.pv-form-success').exists()).toBe(true);
  });
});

describe('sendReport', () => {
  const answer = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

  it('POSTs JSON to the API', async () => {
    const fetchFn = vi.fn(answer(200, { ok: true }));
    await expect(sendReport({ pin: '1' }, fetchFn)).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledWith('/api/report-error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"pin":"1"}',
    });
  });

  it('rejects an HTTP error with its status, and an { ok: false } answer', async () => {
    await expect(sendReport({}, answer(429, null))).rejects.toMatchObject({ status: 429 });
    await expect(sendReport({}, answer(200, { ok: false, error: 'no smtp' }))).rejects.toThrow('no smtp');
  });
});

describe('Data Request', () => {
  it('embeds the form, with a link to open it in a new tab', () => {
    const w = mount(DataRequestWindow, { props: { url: 'https://form.example.org/1' } });
    expect(w.get('iframe').attributes()).toMatchObject({ src: 'https://form.example.org/1', title: 'Data Request form' });
    expect(w.get('.pv-embed-foot a').attributes('href')).toBe('https://form.example.org/1');
  });

  it("uses the county's form only when it's an http(s) URL", () => {
    expect(dataRequestUrl({ forms: { dataRequest: 'https://county.example.org/form' } })).toBe('https://county.example.org/form');
    expect(dataRequestUrl({ forms: { dataRequest: 'javascript:alert(1)' } })).toBe('https://form.jotform.com/261544522974159');
    expect(dataRequestUrl({})).toBe('https://form.jotform.com/261544522974159');
  });
});

describe('Print', () => {
  it('with a parcel: prints or downloads its summary, closing the window first', async () => {
    const order = [];
    const doc = { printParcelSummary: vi.fn(() => order.push('print')), downloadParcelSummary: vi.fn(() => order.push('dl')) };
    const parcel = { id: 1, pin: 'P-1' };
    const w = mount(PrintWindow, { props: { parcel, doc, print: vi.fn(), close: () => order.push('close') } });
    expect(w.text()).toContain('parcel summary for P-1');
    expect(w.find('#pv-print-now').exists()).toBe(false);
    await w.get('#pv-print-summary').trigger('click');
    await flushPromises();
    await w.get('#pv-dl-summary').trigger('click');
    await flushPromises();
    expect(order).toEqual(['close', 'print', 'close', 'dl']);
    expect(doc.printParcelSummary).toHaveBeenCalledWith(parcel);
    expect(doc.downloadParcelSummary).toHaveBeenCalledWith(parcel);
  });

  it('with no parcel (or no PV_DOC): prints the browser view', async () => {
    const print = vi.fn();
    const close = vi.fn();
    const doc = { printParcelSummary: vi.fn(), downloadParcelSummary: vi.fn() };
    for (const props of [{ parcel: null, doc }, { parcel: { pin: 'P-1' }, doc: null }]) {
      const w = mount(PrintWindow, { props: { ...props, print, close } });
      expect(w.find('#pv-print-summary').exists()).toBe(false);
      await w.get('#pv-print-now').trigger('click');
      await flushPromises();
    }
    expect(print).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('Street View', () => {
  const turf = { bearing: () => -90 };   // due west

  it('builds the Google URLs, facing the target', () => {
    expect(heading([1, 2], [1, 2], turf)).toBe(null);   // same spot
    expect(heading([1, 2], [0, 2], turf)).toBe(270);
    expect(heading([1, 2], [0, 2], null)).toBe(null);
    expect(mapsUrl([-85.9, 42.2], [-86, 42.2], turf))
      .toBe('https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=42.2%2C-85.9&heading=270');
    expect(embedUrl('k&1', [-85.9, 42.2], [-85.9, 42.2], turf))
      .toBe('https://www.google.com/maps/embed/v1/streetview?key=k%261&location=42.2%2C-85.9&pitch=0&fov=90');
  });

  describe('resolveTarget', () => {
    const parcel = { id: 7, centroid: [-85.9, 42.2] };
    const fetchFrom = (routes) => vi.fn(async (url) => {
      const hit = Object.keys(routes).find((k) => url.includes(k));
      if (!hit || routes[hit] instanceof Error) throw routes[hit] || new Error('no route');
      return { json: async () => routes[hit] };
    });

    it("uses the parcel's address point first", async () => {
      const fetchFn = fetchFrom({ 'streetview-target?id=7': { ok: true, viewpoint: [-85.91, 42.2], lookAt: [-85.9, 42.2], address: '1 MAIN' } });
      await expect(resolveTarget(parcel, { base: '/api', fetchFn }))
        .resolves.toEqual({ vp: [-85.91, 42.2], lookAt: [-85.9, 42.2], address: '1 MAIN' });
    });

    it('else the nearest road, else the centroid', async () => {
      let fetchFn = fetchFrom({ 'streetview-target': { ok: false }, 'nearest-road?lng=-85.9&lat=42.2': { lng: -85.95, lat: 42.21 } });
      await expect(resolveTarget(parcel, { base: '/api', fetchFn }))
        .resolves.toEqual({ vp: [-85.95, 42.21], lookAt: [-85.9, 42.2], address: null });
      fetchFn = fetchFrom({ 'streetview-target': new Error('down'), 'nearest-road': new Error('down') });
      await expect(resolveTarget(parcel, { base: '/api', fetchFn }))
        .resolves.toEqual({ vp: [-85.9, 42.2], lookAt: [-85.9, 42.2], address: null });
    });
  });

  it('says to pick a parcel when none is selected', () => {
    const w = mount(StreetViewWindow, { props: { parcel: null } });
    expect(w.get('.pv-modal-lead').text()).toBe('Select a parcel first.');
  });

  it('finds the viewpoint, then embeds it with a Google Maps link', async () => {
    let done;
    const resolve = () => new Promise((r) => { done = r; });
    const w = mount(StreetViewWindow, { props: { parcel: { id: 1, site_address: '2 OAK' }, apiKey: 'k', resolve, turf } });
    expect(w.get('[role="status"]').text()).toBe('Finding the nearest street view…');
    done({ vp: [-85.9, 42.2], lookAt: [-86, 42.2], address: null });
    await flushPromises();
    expect(w.get('iframe').attributes('title')).toBe('Street View of 2 OAK');
    expect(w.get('iframe').attributes('src'))
      .toBe('https://www.google.com/maps/embed/v1/streetview?key=k&location=42.2%2C-85.9&heading=270&pitch=0&fov=90');
    expect(w.get('.pv-sv-open').attributes('href'))
      .toBe('https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=42.2%2C-85.9&heading=270');
  });

  describe('openStreetView', () => {
    const parcel = { id: 1, centroid: [-85.9, 42.2] };
    afterEach(() => { delete globalThis.PS_STATE; delete globalThis.COUNTY; vi.unstubAllGlobals(); });

    it('with no parcel: the window that says so', () => {
      const modal = { open: vi.fn() };
      openStreetView(modal);
      expect(modal.open).toHaveBeenCalledWith('Street View', { component: StreetViewWindow, props: { parcel: null } });
    });

    it("with the county's embed key: the wide, flush window", () => {
      globalThis.PS_STATE = { parcel };
      globalThis.COUNTY = { integrations: { googleMapsEmbedKey: 'k' } };
      const modal = { open: vi.fn() };
      openStreetView(modal);
      const [title, body, , opts] = modal.open.mock.calls[0];
      expect([title, body.component, body.props.apiKey, opts]).toEqual(['Street View', StreetViewWindow, 'k', { wide: true, flush: true }]);
    });

    it('without a key: a new tab, opened at once, then sent to the viewpoint', async () => {
      globalThis.PS_STATE = { parcel };
      const fetchFn = vi.fn(async () => ({ json: async () => ({ ok: true, viewpoint: [-85.91, 42.2] }) }));
      vi.stubGlobal('fetch', fetchFn);
      const tab = { location: { href: 'about:blank' }, opener: 'me' };
      const win = { open: vi.fn(() => tab) };
      const modal = { open: vi.fn() };
      openStreetView(modal, { win });
      expect(win.open).toHaveBeenCalledWith('about:blank', '_blank');
      expect(tab.opener).toBe(null);
      expect(modal.open).not.toHaveBeenCalled();
      await flushPromises();
      expect(fetchFn).toHaveBeenCalledWith('/api/streetview-target?id=1');
      expect(tab.location.href).toMatch(/^https:\/\/www\.google\.com\/maps\/@\?api=1&map_action=pano&viewpoint=42\.2%2C-85\.91/);
    });
  });
});

describe('PV_WINDOWS', () => {
  it('opens a window in the modal by name, with its options', () => {
    const open = vi.fn();
    globalThis.PV_MODAL = { open };
    const api = mountWindows();
    expect(api.open('help')).toBe(true);
    expect(open).toHaveBeenCalledWith('Help', { component: HelpWindow, props: {} }, null, undefined);
    expect(api.open('data-request')).toBe(true);
    expect(open).toHaveBeenLastCalledWith('Data Request',
      { component: DataRequestWindow, props: { url: 'https://form.jotform.com/261544522974159' } },
      null, { wide: true, flush: true });
    expect(api.has('streetview')).toBe(true);
    expect(api.has('packet')).toBe(true);
    expect(api.open('tax')).toBe(false);   // still admin-menu.js's (with pv-explain.js)
    delete globalThis.PV_MODAL;
  });
});
