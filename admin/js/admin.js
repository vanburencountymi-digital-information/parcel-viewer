/**
 * admin.js — the Parcel Viewer Admin Console's modules (DIC-467).
 *
 * Config-as-data. The console's shell (nav, top bar, staff sign-in) and its config and
 * draft (the /config API, DIC-465, over the baked window.COUNTY; save, publish, history)
 * are Vue since DIC-2389: frontend/src/admin-console, and so are the modules but one.
 * The Theme Manifest is still drawn here as HTML strings, until it moves too. It
 * registers its render(host) in window.PV_ADMIN_LEGACY.renderers; the shell calls
 * attach(store) with its store before the first render.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function pageHead(title, sub) {
    return '<div class="ac-page-head"><h1 class="ac-page-title">' + esc(title) + '</h1>' +
      '<p class="ac-page-sub">' + esc(sub) + '</p></div>';
  }

  // The Map Buddy service (the Theme Manifest's AI health and autoconfigure); resolve its
  // base the same way the viewer does (window override first, for testing).
  // Resolved in pv-endpoints.js (DIC-1856) — no service URL lives in this file.
  function explainBase() {
    return window.PV_ENDPOINTS ? window.PV_ENDPOINTS.mapBuddyBase() : (window.MAP_BUDDY_API || '/map-buddy-api');
  }
  // The console store (frontend/src/admin-console/store.js) and its state ({active,
  // config, source, editing, draft}), set by attach() before any module renders.
  var CONSOLE = null;
  var STATE = null;
  function clone(o) { return CONSOLE.clone(o); }

  function flash(host, kind, msg) {
    var box = host.querySelector('#ac-flash');
    if (box) box.innerHTML = '<div class="ac-flash ac-flash-' + kind + '">' + esc(msg) + '</div>';
  }
  // A store result ({ok, message}) as the module's flash.
  function flashResult(host, res) { flash(host, res.ok ? 'ok' : 'err', res.message); }

  // Version history and Restore (the Theme Manifest's; the Vue modules have ModuleFrame).
  function loadHistory(host) {
    var box = host.querySelector('#ac-history');
    box.innerHTML = '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Version history</h2></div><p class="ac-readonly">Loading…</p></div>';
    CONSOLE.versions().then(function (res) {
      if (!res.ok) { box.innerHTML = '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Version history</h2></div><p class="ac-readonly">' + esc(res.message) + '</p></div>'; return; }
      var vs = res.versions;
      var rows = vs.map(function (v) {
        return '<tr><td>v' + esc(v.version) + '</td><td>' + esc(v.note || '') + '</td><td>' + esc(v.created_by || '') + '</td>' +
          '<td>' + esc((v.created_at || '').slice(0, 19).replace('T', ' ')) + '</td>' +
          '<td><button class="ac-btn ac-btn-sm" data-rollback="' + esc(v.version) + '">Restore</button></td></tr>';
      }).join('');
      box.innerHTML = '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Version history</h2>' +
        '<span class="ac-card-note">' + vs.length + ' published version(s)</span></div>' +
        (vs.length ? '<table class="ac-table"><thead><tr><th>Version</th><th>Note</th><th>By</th><th>When</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
                   : '<p class="ac-readonly">No published versions yet.</p>') + '</div>';
    });
  }

  function doRollback(host, version, rerender) {
    CONSOLE.rollback(version).then(function (res) {
      if (!res.ok) { flashResult(host, res); return; }
      rerender(host); loadHistory(host); flashResult(host, res);
    });
  }

  // ── Theme Manifest module (B2 manual builder · DIC-578) ─────────────────────
  // Unifies every editor slice into ONE §5 theme manifest and validates it through
  // the SAME loadManifest() gate CI + the engine boot use (C2 / DIC-583). Surfaces:
  // a complete view of the manifest, the capability selection + per-capability AI
  // tri-state the manifest owns (no single module does), Export, and a validated
  // raw-edit fallback (no one-way doors, §4.11).
  //
  // Round-trip (inc 2): the manifest is CANONICAL (§4.11), persisted INSIDE the
  // versioned config under a `manifest` key so it rides the existing draft/publish
  // store (DIC-464/465/466) — no new endpoint. The module PREFERS the saved manifest
  // on open, so open→edit→Save→reopen returns exactly what was saved (no loss).
  // "Re-assemble from modules" regenerates from the live editor slices (the escape
  // hatch — never a one-way door). When the writable store isn't provisioned, Save
  // degrades to the same calm 503 notice every editable module shows.
  var COUNTY_IDFIELDS = { parcels: 'pin' };   // per-source idField hints (until §5 sources land in the store)
  var _mfForceAssemble = false;               // next render regenerates from modules, ignoring the saved manifest

  // Console-side AI-availability auto-fallback (B4 / DIC-580). Mirrors the viewer's
  // pv-ai-health: poll the AI service; when it's unreachable the console drops to
  // manual-only — the B3 autoconfigure card degrades to its deterministic baseline (no AI
  // refinement) with a calm notice, and the manual editor is unaffected. No data loss.
  var AI_HEALTH = { available: true, checked: false };
  var _aiHealthTimer = null;

  function aiReachable() { return AI_HEALTH.available; }

  function _paintAiHealth() {
    var el = document.getElementById('ac-ac-health');
    if (!el) return;
    el.innerHTML = (AI_HEALTH.checked && !AI_HEALTH.available)
      ? '<span style="color:#9a6700">⚠ AI service unreachable — autoconfigure runs in deterministic baseline mode; the manual builder below is unaffected.</span>'
      : '';
  }

  function checkAiHealth() {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var to = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, 4000) : null;
    return fetch(explainBase() + '/health', { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) { AI_HEALTH.available = !!(r && r.ok); })
      .catch(function () { AI_HEALTH.available = false; })
      .then(function () { if (to) clearTimeout(to); AI_HEALTH.checked = true; _paintAiHealth(); });
  }

  function startAiHealth() {
    checkAiHealth();
    if (!_aiHealthTimer) _aiHealthTimer = setInterval(checkAiHealth, 30000);
  }

  function assembleCurrentManifest() {
    var asm = window.ISV_MANIFEST_ASSEMBLE;
    if (!asm) return null;
    return asm.assembleManifest(STATE.config || {}, { tenant: CONSOLE.countyKey, idFields: COUNTY_IDFIELDS });
  }
  // The manifest persisted in the store (draft wins over published) — the canonical
  // artifact. Null until one has been saved.
  function savedManifest() {
    if (STATE.draft && STATE.draft.manifest) return STATE.draft.manifest;
    if (STATE.config && STATE.config.manifest) return STATE.config.manifest;
    return null;
  }
  function validateManifest(manifest) {
    var loader = window.ISV_LOAD_MANIFEST;
    if (!loader || !manifest) return { ok: false, errors: ['ISV engine load-manifest.js not loaded'] };
    return loader.loadManifest(manifest);
  }
  function downloadJson(name, obj) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // Persist `manifest` into the versioned config draft (and optionally publish),
  // reusing the exact draft/publish store plumbing the other modules use. The
  // manifest lives under config.manifest so it round-trips through the same store.
  function persistManifest(host, manifest, publish) {
    CONSOLE.ensureDraft().manifest = manifest;
    if (!publish) {
      CONSOLE.save().then(function (res) {
        if (!res.ok) { flashResult(host, res); return; }
        flash(host, 'ok', 'Manifest saved to draft. Reopen to confirm it round-trips.'); renderManifest(host);
      });
      return;
    }
    CONSOLE.publish('Published theme manifest from console').then(function (res) {
      if (res.ok) renderManifest(host);
      flashResult(host, res);
    });
  }

  function renderManifest(host) {
    if (!window.ISV_MANIFEST_ASSEMBLE) {
      host.innerHTML = pageHead('Theme Manifest',
        'One versioned, exportable theme manifest assembled from every module.') +
        '<div class="ac-banner ac-banner-edit"><span>⚠</span><div>The ISV engine bundle isn’t loaded on this page, so the manifest assembler is unavailable. Ensure the <code>/engine/</code> scripts are included.</div></div>';
      return;
    }
    // Prefer the SAVED (canonical) manifest on open; assemble only when none is stored
    // or the user explicitly re-assembled. This is what makes Save→reopen lossless.
    var saved = _mfForceAssemble ? null : savedManifest();
    _mfForceAssemble = false;
    var manifest = saved ? clone(saved) : assembleCurrentManifest();
    var res = validateManifest(manifest);
    var json = JSON.stringify(manifest, null, 2);

    var sourceNote = saved
      ? '<div class="ac-banner"><span>❖</span><div>Showing the <b>saved manifest</b> from the config store. Edit below and <b>Save to draft</b>, or <b>Re-assemble from modules</b> to regenerate from the current editor values.</div></div>'
      : '<div class="ac-banner"><span>⚙</span><div>Assembled from the current module values (<b>not yet saved</b>). <b>Save to draft</b> to persist it as the canonical manifest.</div></div>';
    var status = res.ok
      ? '<div class="ac-banner"><span>✓</span><div><b>Schema-valid</b> theme manifest (v' + esc(manifest.manifestVersion) +
        ', tenant <code>' + esc(manifest.tenant || '—') + '</code>). Round-trips through the same <code>loadManifest()</code> gate CI and the engine boot use.</div></div>'
      : '<div class="ac-banner ac-banner-edit"><span>⚠</span><div><b>Not yet schema-valid:</b><ul>' +
        (res.errors || []).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';

    var caps = manifest.capabilities || {};
    var capRows = Object.keys(caps).map(function (id) {
      return '<tr><td>' + esc(id) + '</td><td><code>' + esc(caps[id].ai || 'no-ai') + '</code></td><td>' + esc(caps[id].disclosure || '—') + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="ac-readonly">No capabilities enabled.</td></tr>';

    host.innerHTML =
      '<div class="ac-page-head ac-page-head-row"><div>' +
        '<h1 class="ac-page-title">Theme Manifest</h1>' +
        '<p class="ac-page-sub">One versioned, exportable manifest assembled from every module — the artifact the engine boots from.</p></div>' +
        '<div class="ac-toolbar">' +
          '<button class="ac-btn ac-btn-primary" data-mf="save">Save to draft</button>' +
          '<button class="ac-btn ac-btn-primary" data-mf="publish">Publish</button>' +
          '<button class="ac-btn" data-mf="export">Export</button>' +
          '<button class="ac-btn" data-mf="reassemble">Re-assemble from modules</button>' +
          '<button class="ac-btn" data-mf="history">Version history</button>' +
        '</div></div>' +
      '<div id="ac-flash" role="status" data-testid="ac-flash"></div>' + sourceNote + status +
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Capabilities &amp; AI mode</h2>' +
        '<span class="ac-card-note">capability selection + per-capability AI tri-state — owned by the manifest, not any single module</span></div>' +
        '<table class="ac-table"><thead><tr><th>Capability</th><th>AI mode</th><th>Disclosure</th></tr></thead><tbody>' + capRows + '</tbody></table></div>' +
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">AI autoconfigure (draft)</h2>' +
        '<span class="ac-card-note">a brief → draft manifest + rationale, dropped into the editor below for review. AI proposes, you dispose (§4.12); works with no AI service.</span></div>' +
        (window.ISV_THEME_COMPOSER_CORE
          ? '<dl class="ac-grid">' +
              '<dt>Topic</dt><dd><input class="ac-input" id="ac-ac-topic" value="parcels, assessment and tax" placeholder="e.g. parcels, zoning and tax"></dd>' +
              '<dt>Intent</dt><dd><select class="ac-input" id="ac-ac-intent"><option value="public">Public</option><option value="staff">Staff</option><option value="staff analysis">Staff analysis</option></select></dd>' +
              '<dt>AI assistant</dt><dd><input type="checkbox" id="ac-ac-ai" checked> <span class="ac-card-note">include Map Buddy</span></dd></dl>' +
              '<div id="ac-ac-health" class="ac-card-note"></div>' +
              '<div class="ac-toolbar" style="margin-top:8px;align-items:center">' +
                '<button class="ac-btn ac-btn-primary" data-mf="autoconfigure">Generate draft</button>' +
                '<span id="ac-ac-result" class="ac-card-note"></span></div>' +
              '<div id="ac-ac-refine" style="margin-top:8px"></div>'
          : '<p class="ac-readonly">The theme-composer capability isn’t loaded on this page.</p>') +
      '</div>' +
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Manifest — complete view &amp; validated raw-edit</h2>' +
        '<span class="ac-card-note">a complete, editable view of the manifest; edit the JSON, Validate, then Save (no one-way doors, §4.11)</span></div>' +
        '<textarea id="ac-mf-raw" class="ac-input" spellcheck="false" style="width:100%;min-height:340px;font-family:ui-monospace,Menlo,monospace;white-space:pre;tab-size:2">' + esc(json) + '</textarea>' +
        '<div class="ac-toolbar" style="margin-top:8px;align-items:center">' +
          '<button class="ac-btn ac-btn-primary" data-mf="validate">Validate</button>' +
          '<button class="ac-btn" data-mf="export-edited">Export edited</button>' +
          '<span id="ac-mf-result" class="ac-card-note"></span>' +
        '</div></div>' +
      '<div id="ac-history"></div>';

    // B4: reflect the last known AI-health state immediately, then (re)start polling so
    // the autoconfigure card degrades/recovers without a full re-render.
    _paintAiHealth();
    startAiHealth();

    if (host._mfWired) return;
    host._mfWired = true;
    host.addEventListener('click', function (ev) {
      var rb = ev.target.closest('[data-rollback]');
      if (rb) return doRollback(host, parseInt(rb.getAttribute('data-rollback'), 10), renderManifest);
      var b = ev.target.closest('[data-mf]'); if (!b) return;
      var act = b.getAttribute('data-mf');
      if (act === 'reassemble') { _mfForceAssemble = true; return renderManifest(host); }
      if (act === 'history') { return loadHistory(host); }
      if (act === 'export') {
        var cur = savedManifest() || assembleCurrentManifest();
        return downloadJson((cur && cur.id || 'theme') + '.manifest.json', cur);
      }
      if (act === 'autoconfigure') {
        // B3: AI proposes a draft (deterministic core; AI refinement is graceful-absent)
        // → drop it into the editor for human review/publish. No blind publish (§4.12).
        var composer = window.ISV_THEME_COMPOSER_CORE;
        var acOut = host.querySelector('#ac-ac-result');
        if (!composer) { if (acOut) acOut.textContent = 'composer unavailable'; return; }
        var base = assembleCurrentManifest() || {};
        var wantAi = !!(host.querySelector('#ac-ac-ai') || {}).checked;
        var brief = {
          tenant: base.tenant,
          name: (base.branding && base.branding.name) || (STATE.config && STATE.config.name),
          topic: (host.querySelector('#ac-ac-topic') || {}).value || 'general',
          intent: (host.querySelector('#ac-ac-intent') || {}).value || 'public',
          ai: wantAi,
          sources: base.sources || [],
          center: base.map && base.map.center,
          zoom: base.map && base.map.zoom,
        };
        var result = composer.core(brief);
        var draft = result.facts.draftManifest;       // DETERMINISTIC — the editor's source of truth
        var rawEl = host.querySelector('#ac-mf-raw');
        if (rawEl) rawEl.value = JSON.stringify(draft, null, 2);   // into the review editor
        var vr = validateManifest(draft);
        // B4: when AI is unreachable the deterministic draft still works (degrade-to-facts).
        var aiNote = (wantAi && aiReachable()) ? '' : ' (AI refinement skipped — service unreachable)';
        if (acOut) acOut.innerHTML = (vr.ok
          ? '<span style="color:#2f6b4f">✓ schema-valid draft' + esc(aiNote) + '</span> · '
          : '<span style="color:#b11e2f">✗ ' + esc((vr.errors || []).join('; ')) + '</span> · ') + esc(result.facts.rationale);
        var refEl = host.querySelector('#ac-ac-refine');
        if (refEl) refEl.innerHTML = '';
        // B3 AI layer: narrate over the deterministic draft (rationale + suggestions). Async,
        // additive — the draft is already in the editor; this only enriches the rationale.
        if (wantAi && aiReachable() && vr.ok && refEl) {
          refEl.innerHTML = '<span class="ac-card-note">Asking the AI to review the draft…</span>';
          fetch(explainBase() + '/autoconfigure', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
            body: JSON.stringify({ brief: brief, draft: draft, rationale: result.facts.rationale }),
          }).then(function (r) { return r.ok ? r.json() : { ok: false }; })
            .then(function (res) {
              if (!res || !res.ok || !res.refinement) { refEl.innerHTML = ''; return; }
              var rf = res.refinement;
              var sug = (rf.suggestions || []).map(function (s) {
                return '<li><code>' + esc(s.field || '') + '</code> — ' + esc(s.change || '') +
                  (s.why ? ' <span class="ac-card-note">(' + esc(s.why) + ')</span>' : '') + '</li>';
              }).join('');
              refEl.innerHTML = '<div class="ac-banner"><span>✦</span><div><b>AI review:</b> ' + esc(rf.rationale || '') +
                (sug ? '<br><b>Suggested tweaks</b> (apply in the editor):<ul>' + sug + '</ul>' : '') + '</div></div>';
            })
            .catch(function () { refEl.innerHTML = ''; });   // graceful: draft stands
        }
        return;
      }
      // textarea-driven actions (validate / save / publish / export-edited).
      var ta = host.querySelector('#ac-mf-raw');
      var out = host.querySelector('#ac-mf-result');
      var parsed;
      try { parsed = JSON.parse(ta.value); }
      catch (e) { if (out) out.innerHTML = '<span style="color:#b11e2f">✗ Invalid JSON: ' + esc(e.message) + '</span>'; return; }
      if (act === 'export-edited') { return downloadJson((parsed.id || 'theme') + '.manifest.json', parsed); }
      if (act === 'validate') {
        var r = validateManifest(parsed);
        if (!out) return;
        out.innerHTML = r.ok
          ? '<span style="color:#2f6b4f">✓ Schema-valid' + (r.applied && r.applied.length ? ' (migrated ' + esc(r.applied.join(', ')) + ')' : '') + '</span>'
          : '<span style="color:#b11e2f">✗ ' + esc((r.errors || []).join('; ')) + '</span>';
        return;
      }
      if (act === 'save' || act === 'publish') {
        // Never persist an invalid manifest — validate at the same gate first.
        var vr = validateManifest(parsed);
        if (!vr.ok) { flash(host, 'err', 'Manifest is not schema-valid — fix it before saving: ' + (vr.errors || []).join('; ')); return; }
        return persistManifest(host, vr.manifest || parsed, act === 'publish');
      }
    });
  }

  // ── Module registry ─────────────────────────────────────────────────────────
  // The module still drawn here, by id. The shell (frontend/src/admin-console/modules.js)
  // has the nav and the Vue modules; it calls attach() with its store first.
  var RENDERERS = {
    manifest: renderManifest,
  };
  window.PV_ADMIN_LEGACY = {
    renderers: RENDERERS,
    attach: function (store) { CONSOLE = store; STATE = store.state; },
  };
}());
