// The Help & tools menu and the viewer's modal (DIC-2389 slice 5). The e2e suite checks the
// windows themselves (tool-windows, settings, bookmarks-and-share, explainers…).
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import ModalHost from '../modal/ModalHost.vue';
import { createModalStore } from '../modal/store.js';
import HelpMenu from './HelpMenu.vue';
import { MENU_ITEMS, visibleItems } from './items.js';

const flush = async () => { await nextTick(); await nextTick(); };

function modal() {
  const app = document.createElement('div');
  app.id = 'app';
  const opener = document.createElement('button');
  app.appendChild(opener);
  document.body.appendChild(app);
  opener.focus();
  const store = createModalStore();
  const w = mount(ModalHost, { props: { store } });
  const cleanup = () => { w.unmount(); app.remove(); };
  return { store, w, app, opener, cleanup };
}
const dialog = () => document.querySelector('[role="dialog"]');

describe('the modal', () => {
  it('shows an HTML body, runs onMount on it once, and focuses Close', async () => {
    const { store, cleanup } = modal();
    const onMount = vi.fn((body) => { body.querySelector('p').textContent = 'filled'; });
    store.open('Help', '<p>loading</p>', onMount);
    await flush();
    expect(dialog().getAttribute('aria-label')).toBe('Help');
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(dialog().querySelector('.pv-modal-body p').textContent).toBe('filled');
    expect(document.activeElement.classList.contains('pv-modal-close')).toBe(true);
    cleanup();
  });

  it('shows a component body', async () => {
    const { store, cleanup } = modal();
    const Body = defineComponent({ props: ['who'], setup: (p) => () => h('p', `hi ${p.who}`) });
    store.open('About', { component: Body, props: { who: 'Jerry' } }, null, { wide: true });
    await flush();
    expect(dialog().textContent).toContain('hi Jerry');
    expect(dialog().classList.contains('pv-modal--wide')).toBe(true);
    cleanup();
  });

  it('makes the page inert while open, and closes on Esc with focus back on the opener', async () => {
    const { store, app, opener, cleanup } = modal();
    store.open('Help', '<p>x</p>');
    await flush();
    expect(app.hasAttribute('inert')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(dialog()).toBeNull();
    expect(app.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
    cleanup();
  });

  it('close({ returnFocus }) sends focus there instead of the opener', async () => {
    // The Sources panel uses this when an explainer's citation opens it (DIC-2182).
    const { store, app, opener, cleanup } = modal();
    const panel = document.createElement('div');
    panel.tabIndex = -1;
    app.appendChild(panel);
    store.open('Assessment', '<p>x</p>');
    await flush();
    store.close({ returnFocus: panel });
    await flush();
    expect(app.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(panel);
    expect(document.activeElement).not.toBe(opener);
    cleanup();
  });

  it('a click event passed to close is ignored, so focus still goes back to the opener', async () => {
    const { store, opener, cleanup } = modal();
    store.open('Help', '<p>x</p>');
    await flush();
    store.close(new MouseEvent('click'));
    await flush();
    expect(document.activeElement).toBe(opener);
    cleanup();
  });

  it('closes on a backdrop click, not on a click inside', async () => {
    const { store, cleanup } = modal();
    store.open('Help', '<p>x</p>');
    await flush();
    dialog().querySelector('p').click();
    expect(store.isOpen()).toBe(true);
    document.querySelector('.pv-modal-backdrop').click();
    expect(store.isOpen()).toBe(false);
    cleanup();
  });

  it('opening another window replaces the first', async () => {
    const { store, cleanup } = modal();
    store.open('Help', '<p>one</p>');
    await flush();
    store.open('About', '<p>two</p>');
    await flush();
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    expect(dialog().textContent).toContain('two');
    cleanup();
  });
});

describe('the menu', () => {
  it('opens and closes, and a choice opens its window', async () => {
    const openTool = vi.fn();
    const w = mount(HelpMenu, { props: { items: visibleItems(), openTool }, attachTo: document.body });
    const btn = w.get('#pv-admin-btn');
    await btn.trigger('click');
    expect(w.get('#pv-admin-menu').attributes('hidden')).toBeUndefined();
    expect(btn.attributes('aria-expanded')).toBe('true');
    await w.get('[data-tool="about"]').trigger('click');
    expect(openTool).toHaveBeenCalledWith('about');
    expect(w.get('#pv-admin-menu').attributes('hidden')).toBe('');
    w.unmount();
  });

  it('closes on Esc and on a click outside', async () => {
    const w = mount(HelpMenu, { props: { items: visibleItems(), openTool: () => {} }, attachTo: document.body });
    await w.get('#pv-admin-btn').trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(w.get('#pv-admin-menu').attributes('hidden')).toBe('');
    await w.get('#pv-admin-btn').trigger('click');
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(w.get('#pv-admin-menu').attributes('hidden')).toBe('');
    w.unmount();
  });

  it('leaves out gated items, and the separators they would strand', () => {
    expect(visibleItems().length).toBe(MENU_ITEMS.length);
    const gated = visibleItems((cap) => cap !== 'print' && cap !== 'share');
    expect(gated.map((i) => i.tool || '—')).toEqual(
      ['bookmark', '—', 'data-request', 'report-error', '—', 'help', 'whats-new', 'about', '—', 'settings']);
  });
});
