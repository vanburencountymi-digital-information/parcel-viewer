// The Theme Manifest as a Vue module (DIC-2389; was admin.js renderManifest), with the
// engine and the AI service faked: no model is called. The e2e suite runs it on the real
// engine with Map Buddy's /health and /autoconfigure stubbed (admin-console.spec.js,
// "manifest: …").
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ThemeManifest from './modules/ThemeManifest.vue';
import { createConsoleStore } from './store.js';

const reply = (status, json = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

// A fake engine: assembles { manifestVersion, tenant, id, capabilities } from the config;
// a manifest is valid unless its manifestVersion is '99.0'.
const engine = () => ({
  assembler: { assembleManifest: vi.fn((cfg, o) => ({ manifestVersion: '1.0', id: 'vb-theme', tenant: o.tenant, branding: { name: cfg.name }, capabilities: { ledger: { ai: 'ai-assist', disclosure: 'labelled' }, search: {} } })) },
  loader: { loadManifest: vi.fn((m) => (m.manifestVersion === '99.0' ? { ok: false, errors: ['too new'] } : { ok: true, manifest: m, applied: m.manifestVersion === '0.9' ? ['0.9→1.0'] : [] })) },
  composer: { core: vi.fn((b) => ({ facts: { draftManifest: { manifestVersion: '1.0', id: 'draft', tenant: b.tenant, topic: b.topic }, rationale: 'Because.' } })) },
});

function setup({ routes = {}, healthy = true, refinement = null, eng = engine(), config = { name: 'Test County' } } = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, opts = {}) => {
    const key = (opts.method || 'GET') + ' ' + url.replace('/api', '');
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined });
    return routes[key] || reply(404);
  });
  const store = createConsoleStore({
    fetch, apiBase: () => '/api', auth: { headers: () => ({}), noteRefused: () => false },
    countyKey: 'test', author: 'console', fallback: structuredClone(config),
    local: () => ({ setItem() {}, removeItem() {} }), open: () => {},
  });
  store.show('manifest');
  const aiCalls = [];
  const ai = {
    base: () => '/mb',
    fetch: vi.fn(async (url, opts = {}) => {
      aiCalls.push({ url, body: opts.body ? JSON.parse(opts.body) : undefined });
      if (url === '/mb/health') return reply(healthy ? 200 : 503);
      return reply(200, refinement ? { ok: true, refinement } : { ok: false });
    }),
  };
  const doc = { createElement: vi.fn(() => ({ click: vi.fn() })), body: { appendChild: vi.fn(), removeChild: vi.fn() } };
  const w = mount(ThemeManifest, { props: { store, engine: eng, ai, doc, healthEveryMs: 60_000 } });
  return { store, calls, aiCalls, doc, eng, w };
}

const btn = (w, name) => w.findAll('button').find((b) => b.text() === name);
const rawJson = (w) => JSON.parse(w.get('#ac-mf-raw').element.value);

afterEach(() => vi.restoreAllMocks());

describe('ThemeManifest', () => {
  it('opens on the manifest assembled from the config, valid, with its capabilities', async () => {
    const { w } = setup();
    await flushPromises();
    expect(w.text()).toContain('Assembled from the current module values (not yet saved).');
    expect(w.text()).toContain('Schema-valid theme manifest (v1.0, tenant test).');
    expect(w.findAll('tbody tr').map((r) => r.text())).toEqual(['ledgerai-assistlabelled', 'searchno-ai—']);
    expect(rawJson(w)).toMatchObject({ tenant: 'test', branding: { name: 'Test County' } });
  });

  it('opens on the saved manifest when there is one, and says when it is not valid', async () => {
    const { w } = setup({ config: { name: 'X', manifest: { manifestVersion: '99.0', tenant: 'saved' } } });
    await flushPromises();
    expect(w.text()).toContain('Showing the saved manifest from the config store.');
    expect(w.get('.ac-banner-edit').text()).toBe('⚠Not yet schema-valid:too new');
    expect(w.text()).toContain('No capabilities enabled.');
  });

  it('Validate says what is wrong, or that it is valid (and migrated)', async () => {
    const { w } = setup();
    await flushPromises();
    await w.get('#ac-mf-raw').setValue('{ nope');
    await btn(w, 'Validate').trigger('click');
    expect(w.get('#ac-mf-result').text()).toMatch(/^✗ Invalid JSON: /);
    await w.get('#ac-mf-raw').setValue('{"manifestVersion":"99.0"}');
    await btn(w, 'Validate').trigger('click');
    expect(w.get('#ac-mf-result').text()).toBe('✗ too new');
    await w.get('#ac-mf-raw').setValue('{"manifestVersion":"0.9"}');
    await btn(w, 'Validate').trigger('click');
    expect(w.get('#ac-mf-result').text()).toBe('✓ Schema-valid (migrated 0.9→1.0)');
  });

  it('Save puts the edited manifest in the draft, says so and shows it as saved; Re-assemble starts over', async () => {
    const { store, calls, w } = setup({ routes: { 'PUT /config/test/draft': reply(200) } });
    await flushPromises();
    const edited = { ...rawJson(w), branding: { name: 'Edited' } };
    await w.get('#ac-mf-raw').setValue(JSON.stringify(edited));
    await btn(w, 'Save to draft').trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toMatchObject({ key: 'PUT /config/test/draft', body: { payload: { name: 'Test County', manifest: edited } } });
    expect(store.state.editing).toBe(true);
    expect(w.get('.ac-flash-ok').text()).toBe('Manifest saved to draft. Reopen to confirm it round-trips.');
    expect(w.text()).toContain('Showing the saved manifest');
    expect(rawJson(w).branding.name).toBe('Edited');

    await btn(w, 'Re-assemble from modules').trigger('click');
    expect(w.text()).toContain('Assembled from the current module values');
    expect(rawJson(w).branding.name).toBe('Test County');
  });

  it('never saves an invalid manifest; a refused save says why; Publish publishes', async () => {
    const { calls, w } = setup({ routes: {
      'PUT /config/test/draft': reply(503),
      'POST /config/test/publish': reply(200, { version: 9 }),
      'GET /config': reply(200, { name: 'Published' }),
    } });
    await flushPromises();
    await w.get('#ac-mf-raw').setValue('{"manifestVersion":"99.0"}');
    await btn(w, 'Save to draft').trigger('click');
    expect(w.get('.ac-flash-err').text()).toBe('Manifest is not schema-valid — fix it before saving: too new');
    expect(calls.some((c) => c.key.startsWith('PUT'))).toBe(false);

    await w.get('#ac-mf-raw').setValue('{"manifestVersion":"1.0","id":"ok"}');
    await btn(w, 'Save to draft').trigger('click');
    await flushPromises();
    expect(w.get('.ac-flash-err').text()).toMatch(/not yet provisioned/);
  });

  it('Publish saves, publishes with its note, and shows the reloaded config', async () => {
    const { calls, w } = setup({ routes: {
      'PUT /config/test/draft': reply(200),
      'POST /config/test/publish': reply(200, { version: 9 }),
      'GET /config': reply(200, { name: 'Published' }),
    } });
    await flushPromises();
    await btn(w, 'Publish').trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.key === 'POST /config/test/publish').body).toEqual({ author: 'console', note: 'Published theme manifest from console' });
    expect(w.get('.ac-flash-ok').text()).toBe('Published version 9.');
    expect(rawJson(w).branding.name).toBe('Published');
  });

  it('Export hands over the current manifest; Export edited the editor’s', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { doc, w } = setup();
    await flushPromises();
    await btn(w, 'Export').trigger('click');
    const a = doc.createElement.mock.results[0].value;
    expect(a).toMatchObject({ href: 'blob:x', download: 'vb-theme.manifest.json' });
    expect(a.click).toHaveBeenCalled();
    expect(JSON.parse(await created.mock.calls[0][0].text())).toMatchObject({ id: 'vb-theme', tenant: 'test' });
    await w.get('#ac-mf-raw').setValue('{"x":1}');
    await btn(w, 'Export edited').trigger('click');
    expect(doc.createElement.mock.results[1].value.download).toBe('theme.manifest.json');
  });

  it('Generate draft puts the deterministic draft in the editor, then shows the AI review', async () => {
    const { aiCalls, eng, w } = setup({ refinement: { rationale: 'Looks <b>ok</b>.', suggestions: [{ field: 'map.zoom', change: 'zoom in', why: 'small' }, { field: 'x' }] } });
    await flushPromises();
    await w.get('#ac-ac-topic').setValue('zoning');
    await w.get('#ac-ac-intent').setValue('staff');
    await btn(w, 'Generate draft').trigger('click');
    expect(eng.composer.core).toHaveBeenCalledWith(expect.objectContaining({ topic: 'zoning', intent: 'staff', ai: true, tenant: 'test', name: 'Test County' }));
    expect(rawJson(w)).toEqual({ manifestVersion: '1.0', id: 'draft', tenant: 'test', topic: 'zoning' });
    expect(w.get('#ac-ac-result').text()).toBe('✓ schema-valid draft · Because.');
    expect(w.get('#ac-ac-refine').text()).toBe('Asking the AI to review the draft…');
    await flushPromises();
    expect(w.get('#ac-ac-refine').text()).toMatch(/^✦AI review: Looks <b>ok<\/b>\./);
    expect(w.findAll('#ac-ac-refine li').map((l) => l.text())).toEqual(['map.zoom — zoom in (small)', 'x —']);
    expect(aiCalls.find((c) => c.url === '/mb/autoconfigure').body).toMatchObject({ draft: rawJson(w), rationale: 'Because.' });
  });

  it('with the AI service down or unticked, the draft stays deterministic and no AI is asked', async () => {
    const { aiCalls, w } = setup({ healthy: false });
    await flushPromises();
    expect(w.get('#ac-ac-health').text()).toMatch(/^⚠ AI service unreachable/);
    await btn(w, 'Generate draft').trigger('click');
    expect(w.get('#ac-ac-result').text()).toBe('✓ schema-valid draft (AI refinement skipped — service unreachable) · Because.');
    await w.get('#ac-ac-ai').setValue(false);
    await btn(w, 'Generate draft').trigger('click');
    await flushPromises();
    expect(aiCalls.filter((c) => c.url.endsWith('/autoconfigure'))).toHaveLength(0);
    expect(w.get('#ac-ac-refine').text()).toBe('');
  });

  it('without the engine, or without the composer, says so', async () => {
    expect(setup({ eng: { assembler: null } }).w.text()).toContain('The ISV engine bundle isn’t loaded on this page');
    const noComposer = setup({ eng: { ...engine(), composer: null } });
    await flushPromises();
    expect(noComposer.w.text()).toContain('The theme-composer capability isn’t loaded on this page.');
  });

  it('checks the AI service again on a timer, and stops when closed', async () => {
    vi.useFakeTimers();
    try {
      const { aiCalls, w } = setup();
      const health = () => aiCalls.filter((c) => c.url === '/mb/health').length;
      expect(health()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(health()).toBe(2);
      w.unmount();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(health()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
