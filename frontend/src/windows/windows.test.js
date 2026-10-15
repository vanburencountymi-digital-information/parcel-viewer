// The Help & tools windows moved to Vue (DIC-2389 slice 5): Help, What's New, About, Share
// and Bookmarks. The e2e suite opens them through the real menu (tool-windows, data-access,
// bookmarks-and-share).
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import AboutWindow from './AboutWindow.vue';
import BookmarksWindow from './BookmarksWindow.vue';
import HelpWindow from './HelpWindow.vue';
import ShareWindow from './ShareWindow.vue';
import WhatsNewWindow from './WhatsNewWindow.vue';
import { mountWindows } from './index.js';

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

describe('PV_WINDOWS', () => {
  it('opens a window in the modal by name', () => {
    const open = vi.fn();
    globalThis.PV_MODAL = { open };
    const api = mountWindows();
    expect(api.open('help')).toBe(true);
    expect(open).toHaveBeenCalledWith('Help', { component: HelpWindow, props: {} });
    expect(api.open('settings')).toBe(false);   // still admin-menu.js's
    delete globalThis.PV_MODAL;
  });
});
