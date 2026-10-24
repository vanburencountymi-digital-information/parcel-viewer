// Map Buddy's map commands (map-buddy/js/map-buddy-commands.js, DIC-2389): the adapter the
// panel hands them, and what they hand back. The map is faked here; the e2e suite runs the
// commands on the real map (map-buddy-commands.spec.js, map-buddy-chat.spec.js).
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(async () => {
  // A classic script: it puts PV_MAP_BUDDY_COMMANDS on window.
  await import('../../../map-buddy/js/map-buddy-commands.js');
});

function fakeUi(parcel = null) {
  return {
    currentParcel: () => parcel,
    info: vi.fn(), results: vi.fn(), suggest: vi.fn(), requestLook: vi.fn(), offerLook: vi.fn(),
  };
}
const create = (ui) => window.PV_MAP_BUDDY_COMMANDS.create(ui);

beforeEach(() => {
  delete window.PS_MAP;
  delete window.PS_MAP_CONTROL_API;
  window.PS_PARCEL_INDEX = [];
});

describe('map-buddy-commands', () => {
  it('runs each command it knows, returning their chips; ignores unknown and prototype names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cmd = create(fakeUi());
    const chips = cmd.run([
      { type: 'zoom_to', payload: { zoom: 12.4 } }, { type: 'nope' }, { type: 'constructor' }, null, { type: 'reset_north' },
    ]);
    expect(chips).toEqual(['🔍 Zoom 12', '🧭 North up']);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('hands suggestions, a look request and a look offer to the panel', () => {
    const ui = fakeUi();
    const chips = create(ui).run([
      { type: 'suggest_actions', payload: { suggestions: ['A', { label: 'B' }] } },
      { type: 'look_at_map', payload: { question: 'Is there a barn?' } },
      { type: 'offer_map_look', payload: { question: 'x'.repeat(600) } },
    ]);
    expect(ui.suggest).toHaveBeenCalledWith(['A', { label: 'B' }]);
    expect(ui.requestLook).toHaveBeenCalledWith('Is there a barn?');
    expect(ui.offerLook.mock.calls[0][0]).toHaveLength(500);
    expect(chips).toEqual(['👁️ Looking at the map']);
  });

  it('a measurement shows its result as an info bubble', () => {
    window.PS_MAP_CONTROL_API = { measureDistance: () => ({ totalFt: 2640 }) };
    const ui = fakeUi();
    expect(create(ui).run([{ type: 'measure_distance', payload: { coordinates: [[0, 0], { lng: 1, lat: 1 }] } }])).toEqual(['📐 Measured distance']);
    expect(ui.info).toHaveBeenCalledWith('<strong>Distance</strong><br>2,640 ft (0.50 mi)');
  });

  it('search lists the matches as result buttons, escaped; none says so; selectResult selects and flies', () => {
    window.PS_PARCEL_INDEX = [
      { properties: { pin: '80-01', owner_name: 'Smith <b>& Co</b>' } },
      { properties: { pin: '80-02', owner_name: 'Jones' } },
    ];
    window.PS_selectParcel = vi.fn();
    const ui = fakeUi();
    const cmd = create(ui);
    expect(cmd.run([{ type: 'search_parcels', payload: { query: '80-' } }])).toEqual(['🔎 2 matches']);
    const html = ui.results.mock.calls[0][0];
    expect(html).toContain('<button class="mb-result-btn" data-pin="80-01">80-01 — Smith &lt;b&gt;&amp; Co&lt;/b&gt;</button>');
    expect(cmd.run([{ type: 'search_parcels', payload: { query: '<i>zz' } }])).toEqual(['No matches']);
    expect(ui.info).toHaveBeenCalledWith('No parcels matched “&lt;i&gt;zz”.');
    cmd.selectResult('80-02');
    expect(window.PS_selectParcel).toHaveBeenCalledWith('80-02');
  });

  it('the parcel commands use the panel’s current parcel', () => {
    window.PV_BOOKMARKS = { add: vi.fn() };
    const parcel = { id: 7, pin: '80-09' };
    expect(create(fakeUi(parcel)).run([{ type: 'bookmark_current' }])).toEqual(['⭐ Bookmarked 80-09']);
    expect(window.PV_BOOKMARKS.add).toHaveBeenCalledWith(parcel);
    expect(create(fakeUi(null)).run([{ type: 'bookmark_current' }])).toEqual([]);
  });

  it('buildMapState reports the view, or null without a map', () => {
    expect(create(fakeUi()).buildMapState()).toBeNull();
    window.PS_MAP = { getCenter: () => ({ lng: -86.0123456789, lat: 42.2 }), getZoom: () => 13.456, getBearing: () => 10.4, getPitch: () => 44.6 };
    expect(create(fakeUi()).buildMapState()).toEqual({ center: [-86.012346, 42.2], zoom: 13.46, bearing: 10, pitch: 45, visible_layers: [], layers: null });
  });
});
