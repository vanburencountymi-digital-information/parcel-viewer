/**
 * theme-composer.core.js — AI autoconfigure capability core (B3 / DIC-579).
 *
 * The Theme Composer's AI door (§7): a brief (county + topic + intent + available sources)
 * → a DRAFT theme manifest + rationale/provenance, which lands in the SAME manual editor
 * (B2) for human review/publish. It never publishes blind (§4.12 — AI proposes, human
 * disposes); it always feeds the manual editor.
 *
 * Built to the §6 contract: core(brief) -> { facts, provenance } is PURE and model-free.
 * The DRAFT MANIFEST is part of `facts`, so it is identical AI-on vs AI-off (§4.6
 * facts-parity) — a valid theme can always be assembled with NO AI (degrade-to-facts,
 * §4.5). The AI layer (register.js narrate) only adds richer prose rationale + suggested
 * tweaks as NARRATION; it never originates the manifest. So autoconfigure "gracefully
 * absent when AI is down" falls out for free: you still get a schema-valid draft.
 *
 * Reuses the B2 building blocks — manifest-assemble (assembleManifest) + capability-catalog
 * — so the draft is exactly what the manual builder would produce, just brief-driven.
 *
 * core(brief) -> { facts: { draftManifest, capabilities, rationale }, provenance: Citation[] }
 *
 * UMD: Node module (harness) + browser global (window.ISV_THEME_COMPOSER_CORE).
 */
(function (root, factory) {
  'use strict';
  var mod = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_THEME_COMPOSER_CORE = mod;
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function req(nodePath, globalName) {
    if (typeof module !== 'undefined' && module.exports) return require(nodePath);
    return root[globalName];
  }
  var ASSEMBLE = req('../manifest-assemble.js', 'ISV_MANIFEST_ASSEMBLE');
  var CATALOG = req('../capability-catalog.js', 'ISV_CAPABILITY_CATALOG');

  // A provenance entry in the shared citation-envelope shape (§6.4): which brief input
  // drove which manifest decision. `state: 'resolves'` — the brief field is the source.
  function cite(anchor, span) {
    return { source_id: 'brief', anchor: anchor, span: span, state: 'resolves' };
  }

  function has(text, words) {
    var t = String(text || '').toLowerCase();
    return words.some(function (w) { return t.indexOf(w) >= 0; });
  }

  // Deterministically choose which capabilities a brief implies. Always include the
  // no-ai basics; add topic/intent-driven ones. Returns { ids, provenance }.
  function chooseCapabilities(brief) {
    var topic = brief.topic || '';
    var intent = brief.intent || '';
    var prov = [];
    var ids = [];
    function add(id, reason) {
      if (ids.indexOf(id) < 0 && CATALOG.byId(id)) { ids.push(id); prov.push(cite('capabilities.' + id, reason)); }
    }

    // Floor: every viewer can search, inspect a feature, toggle layers, print, share.
    ['search', 'parcelInfo', 'layers', 'print', 'share'].forEach(function (id) {
      add(id, 'baseline capability (always enabled)');
    });

    if (has(topic, ['assess', 'tax', 'value', 'zoning', 'legal', 'ordinance', 'statute'])) {
      add('explainer', "topic implies legal/assessment context → enable the explainer");
      add('citations', "grounded explanations need the citation renderer");
    }
    if (has(topic, ['ledger', 'history', 'ownership', 'transfer'])) {
      add('ledger', "topic implies parcel history → enable the ledger");
    }
    if (has(topic + ' ' + intent, ['survey', 'cogo', 'traverse', 'metes', 'bounds'])) {
      add('cogo', "topic implies surveying → enable the COGO traverse tool");
    }
    if (has(intent, ['analy', 'plan', 'measure', 'survey', 'design'])) {
      add('drawing', "analytical intent → enable drawing/annotation");
      add('measure', "analytical intent → enable measure");
    }
    if (brief.ai !== false) {
      add('mapBuddy', "conversational assistance enabled (set ai:false to omit)");
    }
    return { ids: ids, provenance: prov };
  }

  function core(brief) {
    brief = (brief && typeof brief === 'object') ? brief : {};

    var caps = chooseCapabilities(brief);

    // Audience/persona from intent (deterministic).
    var audience = brief.audience || (has(brief.intent, ['staff', 'internal', 'admin']) ? 'staff' : 'public');
    var persona = { audience: audience };
    if (brief.voice) persona.voice = brief.voice;

    var provenance = caps.provenance.slice();
    provenance.push(cite('persona.audience', "intent '" + (brief.intent || '') + "' → audience " + audience));

    // Shape the brief into the config the B2 assembler consumes (sources pass straight
    // through; capabilities + persona are injected). One assembler, two front doors.
    var config = {
      name: brief.name,
      tenant: brief.tenant,
      sources: Array.isArray(brief.sources) ? brief.sources : [],
      map: { center: brief.center, zoom: brief.zoom },
    };
    var draftManifest = ASSEMBLE.assembleManifest(config, {
      tenant: brief.tenant,
      capabilityIds: caps.ids,
      persona: persona,
    });
    provenance.push(cite('sources', (config.sources.length || 0) + ' source(s) carried from the brief'));

    // Deterministic rationale — so AI-OFF still explains itself (degrade-to-facts).
    var aiCaps = caps.ids.filter(function (id) {
      var s = CATALOG.byId(id); return s && s.ai === 'ai-optional';
    });
    var rationale =
      'Enabled ' + caps.ids.length + ' capabilities for "' + (brief.topic || 'general') + '"' +
      (aiCaps.length ? ' (AI-optional: ' + aiCaps.join(', ') + ')' : '') +
      '. Audience: ' + audience + '. ' + config.sources.length + ' source(s) from the brief.';

    return {
      facts: { draftManifest: draftManifest, capabilities: caps.ids, rationale: rationale },
      provenance: provenance,
    };
  }

  return { core: core, chooseCapabilities: chooseCapabilities };
}));
