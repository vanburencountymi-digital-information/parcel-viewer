// The Drawing Tools pane (DIC-2389; was static markup wired by drawing-tools.js). The map
// side is faked here; the e2e suite draws on the real map (measure-and-draw.spec.js).
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import DrawTools from './DrawTools.vue';

// Fakes with the same shape as PS_DRAWING_TOOLS, PS_ANNOTATION_STORE, PS_UNDO_REDO, PS_SNAPPING_ENGINE.
function fakes() {
  const toolSubs = [], storeSubs = [];
  let active = null;
  const style = { strokeColor: '#1d4ed8', strokeWidth: 2, strokeDash: 'solid', fillColor: '#3b82f6', fillOpacity: 0.18, fontSize: 12, arrowStart: false, arrowEnd: false };
  const state = { layerGroups: ['Default'], activeLayerGroup: 'Default', layerVisibility: {}, annotations: { features: [] } };
  const fire = (subs) => subs.forEach((fn) => fn());
  const tools = {
    getActiveDrawTool: () => active,
    setActiveDrawTool: vi.fn((t) => { active = active === t ? null : t; fire(toolSubs); }),
    getCurrentStyle: () => style,
    setStyle: vi.fn((o) => { Object.assign(style, o); fire(toolSubs); }),
    clearAll: vi.fn(() => { state.annotations.features = []; fire(storeSubs); }),
    setSnapping: vi.fn(),
    subscribe: (fn) => { toolSubs.push(fn); return () => {}; },
  };
  const annotations = {
    getState: () => ({ ...state, layerGroups: state.layerGroups.slice() }),
    subscribe: (fn) => { storeSubs.push(fn); return () => {}; },
    addLayerGroup: vi.fn((n) => { state.layerGroups.push(n); fire(storeSubs); }),
    setActiveLayerGroup: vi.fn((n) => { state.activeLayerGroup = n; fire(storeSubs); }),
    setLayerVisibility: vi.fn((n, on) => { state.layerVisibility[n] = on; fire(storeSubs); }),
    removeLayerGroup: vi.fn((n) => { state.layerGroups = state.layerGroups.filter((g) => g !== n); state.activeLayerGroup = 'Default'; fire(storeSubs); }),
  };
  const undo = { canUndo: false, canRedo: false, undo: vi.fn(), redo: vi.fn() };
  const snapping = { config: { enabled: true, targets: { gridPoints: false } }, configure: vi.fn() };
  return { tools, annotations, undo, snapping, state, fire: () => fire(storeSubs) };
}

describe('DrawTools', () => {
  it('a tool button picks its tool and shows it pressed; again turns it off', async () => {
    const f = fakes();
    const w = mount(DrawTools, { props: f });
    expect(w.findAll('.drw-tool-btn').map((b) => b.attributes('id'))).toEqual(['drw-tool-select', 'drw-tool-point',
      'drw-tool-polyline', 'drw-tool-polygon', 'drw-tool-circle', 'drw-tool-freehand', 'drw-tool-text', 'drw-tool-callout']);
    await w.get('#drw-tool-polygon').trigger('click');
    expect(f.tools.setActiveDrawTool).toHaveBeenCalledWith('polygon');
    expect(w.get('#drw-tool-polygon').classes()).toContain('active');
    expect(w.get('#drw-tool-polygon').attributes('aria-pressed')).toBe('true');
    await w.get('#drw-tool-polygon').trigger('click');
    expect(w.find('.drw-tool-btn.active').exists()).toBe(false);
  });

  it('follows a tool or style picked elsewhere (Map Buddy)', async () => {
    const f = fakes();
    const w = mount(DrawTools, { props: f });
    f.tools.setActiveDrawTool('circle');
    f.tools.setStyle({ strokeWidth: 6, strokeColor: '#16a34a' });
    await w.vm.$nextTick();
    expect(w.get('#drw-tool-circle').classes()).toContain('active');
    expect(w.get('#drw-stroke-width-label').text()).toBe('6px');
    expect(w.get('#drw-stroke-swatches .drw-swatch.active').attributes('title')).toBe('#16a34a');
  });

  it('the style picker opens, and each control sets the style', async () => {
    const f = fakes();
    const w = mount(DrawTools, { props: f });
    expect(w.get('#drw-style-picker').attributes('hidden')).toBeDefined();
    await w.get('#drw-style-toggle').trigger('click');
    expect(w.get('#drw-style-picker').attributes('hidden')).toBeUndefined();
    expect(w.get('#drw-style-toggle').attributes('aria-expanded')).toBe('true');
    await w.get('#drw-fill-swatches [title="#ef4444"]').trigger('click');
    await w.get('#drw-stroke-dash').setValue('dotted');
    await w.get('#drw-fill-opacity').setValue('50');
    await w.get('#drw-font-size').setValue('20');
    await w.get('#drw-arrow-end').setValue(true);
    await w.get('#drw-stroke-custom').setValue('#123456');
    expect(f.tools.setStyle.mock.calls.map((c) => c[0])).toEqual([{ fillColor: '#ef4444' }, { strokeDash: 'dotted' },
      { fillOpacity: 0.5 }, { fontSize: 20 }, { arrowEnd: true }, { strokeColor: '#123456' }]);
    expect(w.get('#drw-fill-opacity-label').text()).toBe('50%');
    expect(w.get('#drw-font-size-label').text()).toBe('20px');
    expect(w.find('#drw-stroke-swatches .drw-swatch.active').exists()).toBe(false);   // a custom colour
  });

  it('undo and redo follow the history', async () => {
    const f = fakes();
    const w = mount(DrawTools, { props: f });
    expect(w.get('#drw-undo-btn').attributes('disabled')).toBeDefined();
    f.undo.canUndo = true;
    f.fire();
    await w.vm.$nextTick();
    expect(w.get('#drw-undo-btn').attributes('disabled')).toBeUndefined();
    await w.get('#drw-undo-btn').trigger('click');
    expect(f.undo.undo).toHaveBeenCalled();
  });

  it('Clear asks first, and only when there is something to clear', async () => {
    const f = fakes();
    const confirm = vi.fn(() => true);
    const w = mount(DrawTools, { props: { ...f, confirm } });
    await w.get('#drw-clear-all-btn').trigger('click');
    expect(confirm).not.toHaveBeenCalled();
    f.state.annotations.features = [{}];
    confirm.mockReturnValueOnce(false);
    await w.get('#drw-clear-all-btn').trigger('click');
    expect(f.tools.clearAll).not.toHaveBeenCalled();
    await w.get('#drw-clear-all-btn').trigger('click');
    expect(confirm).toHaveBeenLastCalledWith('Clear all annotations? This cannot be undone.');
    expect(f.tools.clearAll).toHaveBeenCalled();
  });

  it('Snapping and Grid', async () => {
    const f = fakes();
    const w = mount(DrawTools, { props: f });
    expect(w.get('#drw-snap-toggle').element.checked).toBe(true);
    await w.get('#drw-snap-toggle').setValue(false);
    await w.get('#drw-grid-toggle').setValue(true);
    expect(f.tools.setSnapping).toHaveBeenCalledWith(false);
    expect(f.snapping.configure).toHaveBeenCalledWith({ targets: { gridPoints: true } });
  });

  it('layer groups: add (named), make active, hide, delete; Default has no delete', async () => {
    const f = fakes();
    const ask = vi.fn(() => '  Survey  ');
    const w = mount(DrawTools, { props: { ...f, ask } });
    expect(w.findAll('.drw-group-row')).toHaveLength(1);
    expect(w.find('.drw-group-delete').exists()).toBe(false);
    await w.get('#drw-add-group-btn').trigger('click');
    expect(f.annotations.addLayerGroup).toHaveBeenCalledWith('Survey');
    expect(w.findAll('.drw-group-name').map((n) => n.text())).toEqual(['Default', 'Survey']);
    expect(w.get('.drw-group-row.active').text()).toContain('Survey');
    await w.findAll('.drw-group-check')[1].setValue(false);
    expect(f.annotations.setLayerVisibility).toHaveBeenCalledWith('Survey', false);
    await w.findAll('.drw-group-name')[0].trigger('keydown', { key: 'Enter' });
    expect(f.annotations.setActiveLayerGroup).toHaveBeenLastCalledWith('Default');
    await w.get('.drw-group-delete').trigger('click');
    expect(f.annotations.removeLayerGroup).toHaveBeenCalledWith('Survey');
    expect(w.findAll('.drw-group-row')).toHaveLength(1);
    ask.mockReturnValueOnce('   ');
    await w.get('#drw-add-group-btn').trigger('click');
    expect(f.annotations.addLayerGroup).toHaveBeenCalledTimes(1);
  });
});
