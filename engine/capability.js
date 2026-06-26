/**
 * capability.js — ISV capability contract v1 (A1 / DIC-567).
 *
 * The one caller-agnostic invocation seam for the whole platform:
 *
 *     invoke(capabilityId, typedInput, { ai }) -> {
 *       capability, facts, provenance, narration, meta
 *     }
 *
 * Invariants this module enforces in code (ISV_BUILD_SPEC §4, §6):
 *   - §4.1  Source-agnostic. No domain noun appears here — the seam knows only
 *           `capability`, `typedInput`, `facts`, `provenance` (it speaks source /
 *           feature / section, never any one domain's vocabulary).
 *   - §6.1  Typed input only. A core receives its typedInput argument and nothing
 *           else — never a global, never app state, never the registry.
 *   - §4.2  typed input -> deterministic core -> structured output -> provenance.
 *   - §4.3  AI is a CALLER, never in the critical path. `core()` is pure and is
 *           the only thing on the data/render path; `narrate()` is separate and is
 *           never invoked on the AI-off path. The registry asserts this.
 *   - §4.4  AI optional two ways: user toggle (opts.ai) + automatic fallback (a
 *           throwing/absent narrator degrades to AI-off instead of erroring).
 *   - §4.6  Facts-parity. `facts` + `provenance` are identical AI-on vs AI-off;
 *           narration is the only thing that appears/disappears.
 *   - §4.7  Manifest tri-state per capability: 'no-ai' | 'ai-optional' | 'ai-required'.
 *   - §4.8  Provenance is a first-class output, shaped as the citation envelope (§6.4).
 *
 * This is NOT a framework and NOT a new convention — it generalizes the existing
 * "capabilities are named, MCP-callable services" pattern (§6.3). Treat v1 as
 * PROVISIONAL (§4.10): it is derived from two real capabilities (explainer +
 * ledger) and is expected to be refactored as A6/A7 add more.
 *
 * UMD: usable as a vanilla browser global (window.ISV) and as a Node module
 * (require) so the same code the viewer runs is the code the harness tests.
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod; // Node / harness
  root.ISV = mod;                                                            // browser global
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var AI_MODES = ['no-ai', 'ai-optional', 'ai-required'];
  var CITATION_STATES = ['resolves', 'coarse', 'none'];

  // ── Citation envelope (§6.4) ────────────────────────────────────────────────
  // Every provenance entry, from any capability and any source, is this shape, so
  // the KB Citation Renderer can render any of them without a renderer-per-source
  // fork. Honest degradation states: resolves cleanly | coarse (doc exists, anchor
  // approximate) | none (no citable source — render nothing and SAY so).
  function citation(c) {
    c = c || {};
    var state = CITATION_STATES.indexOf(c.state) >= 0 ? c.state : 'none';
    return {
      source_id: c.source_id != null ? String(c.source_id) : null, // the authoritative (Plane A) doc
      anchor: c.anchor != null ? String(c.anchor) : null,          // resolvable locator into it
      span: c.span != null ? String(c.span) : null,                // the passage to highlight
      state: state,
    };
  }

  function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

  // ── Registry + invoke seam ──────────────────────────────────────────────────
  function createRegistry() {
    var caps = Object.create(null);

    // register({ id, aiMode, core, narrate? , version? })
    //   core:    (typedInput) -> { facts, provenance: Citation[] }   PURE, no model.
    //   narrate: (facts, provenance, ctx) -> structuredOutput        AI layer (optional).
    function register(def) {
      if (!def || typeof def.id !== 'string' || !def.id) {
        throw new Error('capability.register: a string `id` is required');
      }
      if (caps[def.id]) throw new Error('capability.register: duplicate id ' + def.id);
      if (AI_MODES.indexOf(def.aiMode) < 0) {
        throw new Error('capability ' + def.id + ': aiMode must be one of ' + AI_MODES.join('/'));
      }
      if (typeof def.core !== 'function') {
        throw new Error('capability ' + def.id + ': `core` must be a function (the deterministic core)');
      }
      // §4.3/§4.5 consistency: a 'no-ai' capability must not ship a narrator, and an
      // 'ai-required' one must (it has no degraded-to-facts-only mode of its own).
      if (def.aiMode === 'no-ai' && def.narrate) {
        throw new Error('capability ' + def.id + ": aiMode 'no-ai' must not define narrate()");
      }
      if (def.aiMode === 'ai-required' && typeof def.narrate !== 'function') {
        throw new Error('capability ' + def.id + ": aiMode 'ai-required' must define narrate()");
      }
      caps[def.id] = {
        id: def.id, aiMode: def.aiMode, core: def.core,
        narrate: typeof def.narrate === 'function' ? def.narrate : null,
        version: def.version || '1',
      };
      return caps[def.id];
    }

    function get(id) { return caps[id] || null; }
    function list() { return Object.keys(caps).map(function (k) {
      return { id: caps[k].id, aiMode: caps[k].aiMode, version: caps[k].version, ai: !!caps[k].narrate };
    }); }

    // Resolve whether AI narration actually applies for this call (§4.4, §4.7).
    //   'no-ai'       -> never.
    //   'ai-required' -> always (the theme has opted the toggle out of existence).
    //   'ai-optional' -> follows the user/runtime request (default OFF / opt-in, §4.4a).
    function aiApplies(aiMode, requested) {
      if (aiMode === 'no-ai') return false;
      if (aiMode === 'ai-required') return true;
      return requested === true || requested === 'on';
    }

    // invoke(capabilityId, typedInput, opts) -> Promise<result>
    //   opts.ai:  true|'on' | false|'off'   the AI-mode request (default off).
    //   opts.ctx: passed verbatim to narrate() (transport, tenant, signal, …) —
    //             this is how the real /explain call (browser) or a mock (harness)
    //             is injected, keeping AI out of the core path and testable.
    async function invoke(capabilityId, typedInput, opts) {
      opts = opts || {};
      var def = caps[capabilityId];
      if (!def) throw new Error('invoke: unknown capability ' + capabilityId);

      // 1) Deterministic core — the ONLY thing on the critical path (§4.3). Pure,
      //    no model, receives only its typed input (§6.1).
      var out = def.core(typedInput);
      if (!isPlainObject(out) || !('facts' in out)) {
        throw new Error('capability ' + capabilityId + ': core() must return { facts, provenance }');
      }
      var facts = out.facts;
      var provenance = Array.isArray(out.provenance) ? out.provenance.map(citation) : [];

      // 2) AI layer — a separate caller over the SAME facts. Never runs AI-off.
      var requested = opts.ai;
      var wantsAi = aiApplies(def.aiMode, requested);
      var narration = null;
      var degraded = false;

      if (wantsAi && def.narrate) {
        try {
          narration = await def.narrate(facts, provenance, opts.ctx || {});
          if (narration == null) degraded = true; // narrator declined / unreachable
        } catch (e) {
          // §4.4b automatic fallback: AI failure degrades to facts, never errors.
          narration = null;
          degraded = true;
        }
      }

      return {
        capability: capabilityId,
        facts: facts,
        provenance: provenance,
        narration: narration,
        meta: {
          aiMode: def.aiMode,
          aiRequested: requested === true || requested === 'on',
          aiApplied: narration != null,
          degraded: degraded,
        },
      };
    }

    return { register: register, get: get, list: list, invoke: invoke, aiApplies: aiApplies };
  }

  var defaultRegistry = createRegistry();

  return {
    // factory (tests build isolated registries; the app shares the default one)
    createRegistry: createRegistry,
    // default-registry conveniences
    register: defaultRegistry.register,
    invoke: defaultRegistry.invoke,
    get: defaultRegistry.get,
    list: defaultRegistry.list,
    registry: defaultRegistry,
    // building blocks
    citation: citation,
    AI_MODES: AI_MODES.slice(),
    CITATION_STATES: CITATION_STATES.slice(),
  };
}));
