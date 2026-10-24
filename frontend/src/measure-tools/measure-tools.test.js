// The Measurement Tools pane (DIC-2389; was static markup wired by measure-tool.js). The
// map side is faked here; the e2e suite measures on the real map (measure-and-draw.spec.js).
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import MeasureTools from './MeasureTools.vue';

// A fake with PS_MEASURE_TOOL's shape for a host-rendered pane.
function fakes() {
  const subs = [], storeSubs = [];
  let active = null, advanced = false;
  const settings = { annotateDistance: true, annotateBearing: false, bearingFormat: 'quadrant', units: 'feet' };
  const fire = (list) => list.forEach((fn) => fn());
  const tool = {
    getActiveTool: () => active,
    toggleTool: vi.fn((t) => { active = active === t ? null : t; fire(subs); }),
    getSettings: () => ({ ...settings }),
    setSetting: vi.fn((k, v) => { settings[k] = v; fire(subs); }),
    isAdvancedExpanded: () => advanced,
    setAdvancedExpanded: vi.fn((on) => { advanced = on; fire(subs); }),
    clearAllMeasurements: vi.fn(),
    subscribe: (fn) => { subs.push(fn); return () => {}; },
  };
  const annotations = { subscribe: (fn) => { storeSubs.push(fn); return () => {}; } };
  const undo = { canUndo: false, canRedo: false, undo: vi.fn(), redo: vi.fn() };
  return { tool, annotations, undo, fireStore: () => fire(storeSubs) };
}

describe('MeasureTools', () => {
  it('a tool button turns its tool on (pressed) and off; follows a tool opened elsewhere', async () => {
    const f = fakes();
    const w = mount(MeasureTools, { props: f });
    await w.get('#msr-tool-area').trigger('click');
    expect(f.tool.toggleTool).toHaveBeenCalledWith('measure-area');
    expect(w.get('#msr-tool-area').classes()).toContain('active');
    expect(w.get('#msr-tool-area').attributes('aria-pressed')).toBe('true');
    f.tool.toggleTool('coordinates');   // e.g. Map Buddy
    await w.vm.$nextTick();
    expect(w.get('#msr-tool-coords').classes()).toContain('active');
    expect(w.get('#msr-tool-area').classes()).not.toContain('active');
  });

  it('settings: the checkboxes and the toggle groups set and show them', async () => {
    const f = fakes();
    const w = mount(MeasureTools, { props: f });
    expect(w.get('.msr-units-grp .active').text()).toBe('Feet');
    await w.get('#msr-ann-bearing').setValue(true);
    await w.get('.msr-units-grp [data-value="miles"]').trigger('click');
    await w.get('.msr-bearing-fmt-grp [data-value="azimuth"]').trigger('click');
    expect(f.tool.setSetting.mock.calls).toEqual([['annotateBearing', true], ['units', 'miles'], ['bearingFormat', 'azimuth']]);
    expect(w.get('.msr-units-grp .active').text()).toBe('Miles');
    expect(w.get('.msr-bearing-fmt-grp [data-value="azimuth"]').attributes('aria-pressed')).toBe('true');
  });

  it('Advanced Tools opens and closes the advanced section', async () => {
    const f = fakes();
    const w = mount(MeasureTools, { props: f });
    expect(w.get('#msr-advanced-body').attributes('hidden')).toBeDefined();
    expect(w.get('#msr-adv-toggle').text()).toBe('▶ Advanced Tools');
    await w.get('#msr-adv-toggle').trigger('click');
    expect(w.get('#msr-adv-toggle').text()).toBe('▼ Advanced Tools');
    expect(w.get('#msr-adv-toggle').attributes('aria-expanded')).toBe('true');
    expect(w.get('#msr-advanced-body').attributes('hidden')).toBeUndefined();
  });

  it('the Dimension Parcel options show only while it is the tool, with their defaults and ids', async () => {
    const f = fakes();
    const w = mount(MeasureTools, { props: f });
    expect(w.get('#msr-autodim-opts').attributes('hidden')).toBeDefined();
    await w.get('#msr-tool-autodim').trigger('click');
    expect(w.get('#msr-autodim-opts').attributes('hidden')).toBeUndefined();
    expect(w.get('#msr-ad-min-seg').element.value).toBe('10');
    expect(w.get('#msr-ad-collinear').element.value).toBe('0.5');
    expect(w.get('#msr-ad-group').element.value).toBe('{PIN} Dimensions');
    expect(w.get('#msr-ad-label-content').element.value).toBe('both');
  });

  it('Offset Line says it is coming; Clear Measurements asks first', async () => {
    const f = fakes();
    const alert = vi.fn();
    const confirm = vi.fn(() => false);
    const w = mount(MeasureTools, { props: { ...f, alert, confirm } });
    await w.get('#msr-tool-offset').trigger('click');
    expect(alert).toHaveBeenCalledWith('Offset Line is coming in a future update.');
    await w.get('#msr-clear-all-btn').trigger('click');
    expect(f.tool.clearAllMeasurements).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await w.get('#msr-clear-all-btn').trigger('click');
    expect(f.tool.clearAllMeasurements).toHaveBeenCalled();
  });

  it('undo and redo follow the history', async () => {
    const f = fakes();
    const w = mount(MeasureTools, { props: f });
    expect(w.get('#msr-undo-btn').attributes('disabled')).toBeDefined();
    f.undo.canUndo = true;
    f.fireStore();
    await w.vm.$nextTick();
    await w.get('#msr-undo-btn').trigger('click');
    expect(f.undo.undo).toHaveBeenCalled();
  });
});
