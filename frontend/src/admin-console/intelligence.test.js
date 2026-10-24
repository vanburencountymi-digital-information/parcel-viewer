// Intelligence as a Vue module (DIC-2389; was admin.js renderIntelligence): the explainer
// plugins, with the Map Buddy service faked. The e2e suite reads the real service and a
// stubbed one (admin-console.spec.js, "intelligence").
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { loadExplainers } from './explainers.js';
import Intelligence from './modules/Intelligence.vue';

const EXPLAINERS = [
  { id: 'assessment', label: 'Assessment Explainer', model: 'claude-test-1', audience: 'Residents',
    callable_via: 'POST /explain', system_prompt: 'Explain <b>plainly</b>.',
    context_blocks: [{ title: 'Statutes', body: 'MCL 211.27a', chars: 11 }, { title: 'Untitled', body: '' }] },
  { id: 'tax', label: 'Tax Description' },
];

async function view(result) {
  const w = mount(Intelligence, { props: { store: {}, load: async () => result } });
  await flushPromises();
  return w;
}

describe('loadExplainers', () => {
  it('asks the service and gives the list, or why it could not', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ explainers: EXPLAINERS }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const base = () => '/mb';
    expect(await loadExplainers({ fetch, base })).toEqual({ explainers: EXPLAINERS });
    expect(fetch).toHaveBeenCalledWith('/mb/explainers', { cache: 'no-cache' });
    expect(await loadExplainers({ fetch, base })).toEqual({ explainers: [] });
    expect(await loadExplainers({ fetch, base })).toEqual({ error: 'HTTP 502' });
    expect(await loadExplainers({ fetch, base })).toEqual({ error: 'Failed to fetch' });
  });
});

describe('Intelligence', () => {
  it('says it is loading until the service answers', () => {
    const w = mount(Intelligence, { props: { store: {}, load: () => new Promise(() => {}) } });
    expect(w.get('#ac-xp-list').text()).toBe('Loading explainer plugins…');
  });

  it('a card per plugin with its id, audience, model and how to call it; dashes when unset', async () => {
    const w = await view({ explainers: EXPLAINERS });
    const cards = w.findAll('.ac-xp-card');
    expect(cards.map((c) => c.attributes('data-xp-id'))).toEqual(['assessment', 'tax']);
    expect(cards[0].get('h2').text()).toBe('Assessment Explainer');
    expect(cards[0].get('.ac-xp-model').text()).toBe('claude-test-1');
    expect(cards[0].findAll('dd').map((d) => d.text())).toEqual(['assessment', 'Residents', 'POST /explain']);
    expect(cards[0].get('.ac-xp-blocks-title').text()).toBe('Injected context (2)');
    expect(cards[1].findAll('dd').map((d) => d.text())).toEqual(['tax', '—', '—']);
    expect(cards[1].get('.ac-xp-model').text()).toBe('—');
    expect(cards[1].find('.ac-xp-blocks-title').exists()).toBe(false);
    expect(cards[1].get('.ac-xp-chars').text()).toBe('0 chars');
  });

  it('each toggle opens and closes its own text, shown as text', async () => {
    const w = await view({ explainers: EXPLAINERS });
    const prompt = w.get('[data-collapse="sp-assessment"]');
    const pre = w.get('#sp-assessment');
    expect(prompt.attributes()).toMatchObject({ 'aria-expanded': 'false', 'aria-controls': 'sp-assessment' });
    expect(prompt.text()).toBe('▸ System prompt 23 chars');
    expect(pre.attributes('hidden')).toBeDefined();
    expect(pre.text()).toBe('Explain <b>plainly</b>.');
    expect(pre.find('b').exists()).toBe(false);

    await prompt.trigger('click');
    expect(prompt.attributes('aria-expanded')).toBe('true');
    expect(prompt.get('.ac-arrow').text()).toBe('▾');
    expect(pre.attributes('hidden')).toBeUndefined();
    expect(w.get('#blk-assessment-0').attributes('hidden')).toBeDefined();

    await w.get('[data-collapse="blk-assessment-1"]').trigger('click');
    expect(w.get('#blk-assessment-1').attributes('hidden')).toBeUndefined();
    expect(w.get('[data-collapse="blk-assessment-1"]').find('.ac-xp-chars').exists()).toBe(false);   // no count given

    await prompt.trigger('click');
    expect(pre.attributes('hidden')).toBeDefined();
  });

  it('no plugins, or no service, says so', async () => {
    expect((await view({ explainers: [] })).get('#ac-xp-list').text()).toBe('No explainer plugins registered.');
    expect((await view({ error: 'HTTP 502' })).get('#ac-xp-list').text()).toMatch(/^Couldn’t reach the Map Buddy service \(HTTP 502\)\./);
  });
});
