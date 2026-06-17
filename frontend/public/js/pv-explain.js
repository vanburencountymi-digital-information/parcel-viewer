/**
 * pv-explain.js — AI-driven per-parcel explainers (DIC-370 Assessment Explainer).
 *
 * Two-engine discipline (verify-don't-trust):
 *   1. Deterministic "truth" — assembleAssessmentFacts() pulls this parcel's
 *      verified figures straight from the API (/parcel/{id}). These numbers are
 *      rendered by US and are never originated by the model.
 *   2. AI "teacher" — the Map Buddy /explain service narrates ONLY those figures
 *      and cites Michigan law from a vetted list (see map-buddy/backend/agent.py).
 *
 * The window is built from a base template via PV_TEMPLATE; print/export reuse
 * PV_DOC. Persistence + stable custom URLs are deferred (DIC-400/372 Phase 4).
 *
 * Exposes: window.PV_EXPLAIN { openAssessment }
 */
(function (root) {
  'use strict';

  var T = root.PV_TEMPLATE;
  function esc(s) { return T ? T.escape(s) : String(s == null ? '' : s); }

  // ── Service endpoints ──────────────────────────────────────────────────────
  function apiBase() { return root.API_BASE || (root.PS_CONFIG && root.PS_CONFIG.API_BASE) || '/api'; }

  // Resolve the Map Buddy service base the same way demo/index.html mounts it, so
  // the explainer talks to the same Cloud Run service (one key, one rate-limiter).
  function explainBase() {
    var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return (root.COUNTY && root.COUNTY.endpoints && root.COUNTY.endpoints.mapBuddy) ||
      root.MAP_BUDDY_API ||
      (isLocal && '/map-buddy-api') ||
      'https://map-buddy-toaozre74a-uc.a.run.app';
  }

  // ── Formatting helpers ─────────────────────────────────────────────────────
  function num(v) { if (v == null || v === '') return null; var n = Number(v); return isNaN(n) ? null : n; }
  function money(v) {
    var n = num(v);
    if (n == null) return null;
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function dash(v) { return (v == null || v === '') ? '—' : v; }

  // Resolve a county code → label using the same maps the popup uses
  // (window.COUNTY.labels, from county-config.js). `style:"code-name"` renders
  // "401 – Residential"; "name" prefers the name and falls back to the code.
  function resolveLabel(mapKey, code, style) {
    code = code != null ? String(code).trim() : null;
    if (!code) return null;
    var name = (root.COUNTY && root.COUNTY.labels && root.COUNTY.labels[mapKey] && root.COUNTY.labels[mapKey][code]) || null;
    if (!name) return code;
    return style === 'code-name' ? (code + ' – ' + name) : name;
  }

  // Split AI prose (blank-line-separated paragraphs) into escaped <p> blocks.
  function paras(text) {
    if (!text) return '';
    return String(text).split(/\n\s*\n/).map(function (p) {
      return '<p>' + esc(p.trim()).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  // ── 1. Deterministic truth layer ───────────────────────────────────────────
  // Pull the authoritative record and assemble the verified figures. Anything we
  // can't get from the DB is simply omitted — never guessed.
  function assembleAssessmentFacts(parcel) {
    var id = parcel && parcel.id;
    if (id == null) return Promise.reject(new Error('no parcel id'));
    return fetch(apiBase() + '/parcel/' + encodeURIComponent(id), { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (feat) {
        var p = (feat && feat.properties) || {};
        var av = num(p.assessed_value);
        // DB stores assessed_value_yr0..yr4 newest-first (see map.js showParcelInfo).
        var histNewestFirst = [p.assessed_value_yr0, p.assessed_value_yr1, p.assessed_value_yr2,
                               p.assessed_value_yr3, p.assessed_value_yr4].map(num);
        // Year-labeled, oldest→newest — clearer for the model and the chart.
        var oldestFirst = histNewestFirst.slice().reverse();
        var curYear = new Date().getFullYear();
        var n = oldestFirst.length;
        var byYear = oldestFirst.map(function (v, i) {
          return { year: curYear - (n - 1 - i), assessed_value: v };
        }).filter(function (e) { return e.assessed_value != null; });
        return {
          pin: p.pin || p.parcel_no || (parcel && parcel.pin) || '',
          owner_name: p.owner_name || null,
          municipality: p.municipality || null,
          school_district: resolveLabel('schoolDist', p.school_dist, 'name'),
          classification: resolveLabel('propClass', p.prop_class, 'code-name'),
          pre_percent: num(p.homestead),
          assessed_value: av,
          prev_assessed_value: num(p.prev_assessed_value),
          taxable_value: num(p.taxable_value),
          prev_taxable_value: num(p.prev_taxable_value),
          // Deterministic, clearly-labeled derivation (same as the popup's TMV):
          true_cash_value_estimate: av != null ? av * 2 : null,
          // Newest-first for the chart (it reverses); year-labeled for the model.
          assessed_value_history: histNewestFirst,
          assessed_value_by_year: byYear,
        };
      });
  }

  // ── 2. AI teacher ──────────────────────────────────────────────────────────
  // Returns the structured explanation, or null on any failure (so the caller
  // degrades to the deterministic figures + static educational fallback).
  function fetchExplanation(facts) {
    return fetch(explainBase() + '/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'assessment', facts: facts }),
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (res) { return (res && res.ok && res.explanation) ? res.explanation : null; })
      .catch(function () { return null; });
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function figureRows(f) {
    var rows = [];
    function add(label, value, note) { if (value != null && value !== '') rows.push({ label: label, value: value, note: note || '' }); }
    add('Assessed Value (AV)', money(f.assessed_value), 'assessor’s estimate of 50% of market value');
    add('Taxable Value (TV)', money(f.taxable_value), 'the value your millage is applied to (capped by Proposal A)');
    add('True Cash Value', money(f.true_cash_value_estimate), 'estimated full market value (about 2× AV)');
    if (f.pre_percent != null) add('Principal Residence Exemption', f.pre_percent + '%', 'share exempt from local school operating tax');
    add('Classification', f.classification, 'Michigan STC property class');
    add('School District', f.school_district, '');
    return rows;
  }

  // 5-year AV trend as a labeled SVG chart (mirrors the popup's chart so the look
  // is consistent). assessed_value_history is newest-first → reverse for
  // oldest→newest, label each bar with its year and value. Bars use a min→max
  // scale (not from zero) so year-over-year changes in a narrow range stay
  // visible; exact dollar values sit above each bar, so nothing is misread.
  function historyChartSvg(f, opts) {
    opts = opts || {};
    var vals = (f.assessed_value_history || []).slice().reverse();
    var valid = vals.filter(function (v) { return v != null; });
    if (valid.length < 2) return '';
    var curYear = new Date().getFullYear();
    var maxV = Math.max.apply(null, valid), minV = Math.min.apply(null, valid);
    var W = 320, H = 96, labelH = 15, valueH = 13, areaH = H - labelH - valueH;
    var n = vals.length, colW = W / n, barW = colW * 0.5;
    var dark = !opts.doc && document.documentElement.getAttribute('data-theme') === 'dark';
    var valClr = dark ? '#b09a7a' : '#6D5C52';
    var yrClr = dark ? '#b9bdc4' : '#4b5563';
    var gTop = dark ? '#6b5a38' : '#CBAB7A', gBot = dark ? '#4a3e26' : '#B58D4A';
    var curFill = dark ? '#d4a862' : '#8B6535';   // current year stands out
    var bars = vals.map(function (v, i) {
      var cx = colW * i + colW / 2, yr = curYear - (n - 1 - i);
      if (v == null) return '<text x="' + cx + '" y="' + (H - 3) + '" text-anchor="middle" font-size="10" fill="' + yrClr + '">' + yr + '</text>';
      var frac = maxV === minV ? 1 : (0.22 + 0.78 * (v - minV) / (maxV - minV));
      var bh = Math.max(3, Math.round(frac * areaH));
      var bx = cx - barW / 2, by = valueH + areaH - bh;
      var lbl = '$' + Math.round(v / 1000) + 'k';
      var fill = i === n - 1 ? curFill : 'url(#xp-av-grad)';
      return '<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2" fill="' + fill + '"/>' +
        '<text x="' + cx + '" y="' + (by - 3).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="600" fill="' + valClr + '">' + lbl + '</text>' +
        '<text x="' + cx + '" y="' + (H - 3) + '" text-anchor="middle" font-size="10" fill="' + yrClr + '">' + yr + '</text>';
    }).join('');
    var defs = '<defs><linearGradient id="xp-av-grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + gTop + '"/><stop offset="100%" stop-color="' + gBot + '"/></linearGradient></defs>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" role="img" aria-label="Five-year assessed value history, oldest to newest">' + defs + bars + '</svg>';
  }

  var TPL =
    '<div class="pv-xp">' +
      '<p class="pv-modal-lead">A plain-language breakdown of this parcel’s assessment—grounded in the county’s recorded figures.</p>' +

      '<div class="pv-xp-figs" role="group" aria-label="Recorded figures">' +
        '<div class="pv-xp-figs-title">By the numbers' +
          '{{#pin}}<span class="pv-xp-pin">{{pin}}</span>{{/pin}}</div>' +
        '<table class="pv-xp-table">{{#figures}}' +
          '<tr><th>{{label}}{{#note}}<span class="pv-xp-note"> · {{note}}</span>{{/note}}</th><td>{{value}}</td></tr>' +
        '{{/figures}}</table>' +
        '{{#history_svg}}<div class="pv-xp-hist"><div class="pv-xp-hist-cap">Assessed value — last {{history_years}} years (current year highlighted)</div>{{{history_svg}}}</div>{{/history_svg}}' +
      '</div>' +

      '{{#has_ai}}' +
        '{{#summary_html}}<div class="pv-xp-summary">{{{summary_html}}}</div>{{/summary_html}}' +
        '{{#sections}}<section class="pv-xp-section"><h3 class="pv-xp-h">{{heading}}</h3><div class="pv-xp-body">{{{body_html}}}</div></section>{{/sections}}' +
        '{{#has_glossary}}<section class="pv-xp-section"><h3 class="pv-xp-h">Key terms</h3><dl class="pv-xp-gloss">{{#glossary}}<dt>{{term}}</dt><dd>{{definition}}</dd>{{/glossary}}</dl></section>{{/has_glossary}}' +
        '{{#has_statutes}}<section class="pv-xp-section"><h3 class="pv-xp-h">Michigan law</h3><ul class="pv-xp-statutes">{{#statutes}}<li><span class="pv-xp-stat-name">{{name}}</span> <span class="pv-xp-stat-cite">{{citation}}</span><span class="pv-xp-stat-plain">{{plain}}</span></li>{{/statutes}}</ul></section>{{/has_statutes}}' +
        '{{#disclaimer}}<p class="pv-modal-note">{{disclaimer}}</p>{{/disclaimer}}' +
      '{{/has_ai}}' +

      '{{^has_ai}}' +
        '{{#fallback_items}}<div class="pv-help-item"><div class="pv-help-h">{{term}}</div><div class="pv-help-p">{{definition}}</div></div>{{/fallback_items}}' +
        '<div class="pv-teaser"><div class="pv-teaser-title"><span class="pv-badge">Offline</span> Live explainer unavailable</div>' +
          '<p class="pv-teaser-body">The figures above are this parcel’s recorded values. The AI walkthrough and statute citations couldn’t be reached right now—the educational summary above still applies.</p></div>' +
      '{{/has_ai}}' +

      '<div class="pv-xp-actions">' +
        '<button type="button" class="pv-btn-ghost" data-xp="print">Print</button>' +
        '<button type="button" class="pv-btn-ghost" data-xp="download">Download HTML</button>' +
      '</div>' +
    '</div>';

  // Concise educational fallback (used only when the AI service is unreachable).
  var FALLBACK_ITEMS = [
    { term: 'Assessed Value (AV) & SEV', definition: 'AV is set by the assessor at 50% of True Cash (market) Value. After county/state equalization confirms that 50% level, AV becomes the State Equalized Value (SEV).' },
    { term: 'Taxable Value (TV) & Proposal A', definition: 'TV is the value you’re actually taxed on. Under Proposal A it rises each year by the lesser of 5% or inflation—so it often sits below AV—until the property sells, when it “uncaps” to the SEV.' },
    { term: 'Assessing vs. equalization vs. appraisal', definition: 'Assessing values every parcel for taxation; equalization checks those values are uniform across units; an appraisal is an independent market-value opinion for a specific purpose.' },
    { term: 'Appeals', definition: 'Disagree with your assessment? Appeal first to the March Board of Review, then the Michigan Tax Tribunal.' },
  ];

  function buildData(facts, explanation) {
    var svg = historyChartSvg(facts);
    var data = {
      pin: facts.pin || '',
      figures: figureRows(facts),
      history_svg: svg,
      history_years: (facts.assessed_value_by_year || []).length,
      has_ai: !!explanation,
    };
    if (explanation) {
      data.summary_html = explanation.summary ? paras(explanation.summary) : '';
      data.sections = (explanation.sections || []).map(function (s) {
        return { heading: s.heading || '', body_html: paras(s.body) };
      });
      data.glossary = explanation.glossary || [];
      data.has_glossary = !!(explanation.glossary && explanation.glossary.length);
      data.statutes = explanation.statutes || [];
      data.has_statutes = !!(explanation.statutes && explanation.statutes.length);
      data.disclaimer = explanation.disclaimer || '';
    } else {
      data.fallback_items = FALLBACK_ITEMS;
    }
    return data;
  }

  function renderHtml(facts, explanation) {
    return T ? T.render(TPL, buildData(facts, explanation)) : '';
  }

  // ── Print / export document ────────────────────────────────────────────────
  var DOC_TPL =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>Assessment — Parcel {{pin}}</title><style>' +
    '*{box-sizing:border-box}body{font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;margin:0;padding:24px;}' +
    '.doc{max-width:760px;margin:0 auto;}' +
    '.dh{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #A3473B;padding-bottom:8px;margin-bottom:16px;}' +
    '.dh-b{font-weight:700;color:#A3473B;font-size:16px;}.dh-s{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;}' +
    'h1{font-size:20px;margin:0 0 14px;}h3{font-size:14px;margin:18px 0 4px;color:#A3473B;}' +
    'table{width:100%;border-collapse:collapse;font-size:13.5px;margin-bottom:8px;}th{text-align:left;width:46%;color:#6b7280;font-weight:600;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;}td{padding:6px 8px;border-bottom:1px solid #eee;}' +
    'dt{font-weight:700;margin-top:6px;}dd{margin:0 0 4px;color:#4b5563;}' +
    '.cite{color:#6b7280;font-size:12px;}.foot{margin-top:20px;font-size:11px;color:#9ca3af;}' +
    '@media print{body{padding:0;}a{color:inherit;text-decoration:none;}}' +
    '</style></head><body><div class="doc">' +
    '<header class="dh"><span class="dh-b">{{county}}</span><span class="dh-s">Property Assessment</span></header>' +
    '<h1>Parcel {{pin}}</h1>' +
    '<table>{{#figures}}<tr><th>{{label}}</th><td>{{value}}</td></tr>{{/figures}}</table>' +
    '{{#history_svg}}<div style="margin:4px 0 12px">{{{history_svg}}}</div>{{/history_svg}}' +
    '{{#has_ai}}{{#summary_text}}<p>{{summary_text}}</p>{{/summary_text}}' +
    '{{#sections}}<h3>{{heading}}</h3><div>{{{body_html}}}</div>{{/sections}}' +
    '{{#has_statutes}}<h3>Michigan law</h3>{{#statutes}}<p><strong>{{name}}</strong> <span class="cite">{{citation}}</span><br>{{plain}}</p>{{/statutes}}{{/has_statutes}}' +
    '{{#disclaimer}}<p class="cite">{{disclaimer}}</p>{{/disclaimer}}{{/has_ai}}' +
    '<footer class="foot">Generated {{generated}} · {{county}} Parcel Viewer · Educational use only.</footer>' +
    '</div></body></html>';

  function docHtml(facts, explanation) {
    if (!T) return '';
    var county = (root.COUNTY && root.COUNTY.name) || 'County';
    var d = {
      county: county, pin: facts.pin || '', figures: figureRows(facts),
      history_svg: historyChartSvg(facts, { doc: true }),
      has_ai: !!explanation,
      generated: (function () { try { return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return ''; } })(),
    };
    if (explanation) {
      d.summary_text = explanation.summary || '';
      d.sections = (explanation.sections || []).map(function (s) { return { heading: s.heading || '', body_html: paras(s.body) }; });
      d.statutes = explanation.statutes || [];
      d.has_statutes = !!(explanation.statutes && explanation.statutes.length);
      d.disclaimer = explanation.disclaimer || '';
    }
    return T.render(DOC_TPL, d);
  }

  function pinSlug(facts) { return String(facts.pin || 'parcel').replace(/[^\w.-]/g, '_'); }

  // ── Orchestration ──────────────────────────────────────────────────────────
  function loadingHtml() {
    return '<div class="pv-xp-loading" role="status">' +
      '<div class="pv-xp-spinner" aria-hidden="true"></div>' +
      '<p>Assembling this parcel’s assessment…</p></div>';
  }

  function errorHtml(msg) {
    return '<p class="pv-modal-lead">Couldn’t load this parcel’s assessment.</p>' +
      '<p class="pv-modal-note">' + esc(msg || 'Please try again.') + '</p>';
  }

  function wireActions(bodyEl, facts, explanation) {
    var pr = bodyEl.querySelector('[data-xp="print"]');
    var dl = bodyEl.querySelector('[data-xp="download"]');
    if (pr && root.PV_DOC) pr.addEventListener('click', function () { root.PV_DOC.print(docHtml(facts, explanation)); });
    if (dl && root.PV_DOC) dl.addEventListener('click', function () { root.PV_DOC.downloadHtml(docHtml(facts, explanation), 'assessment-' + pinSlug(facts) + '.html'); });
  }

  // host = { openModal, closeModal } from admin-menu (which owns the modal).
  function openAssessment(parcel, host) {
    var title = 'Property Assessment' + (parcel && parcel.pin ? ' — ' + parcel.pin : '');
    host.openModal(title, loadingHtml(), function (bodyEl) {
      assembleAssessmentFacts(parcel)
        .then(function (facts) {
          return fetchExplanation(facts).then(function (explanation) {
            bodyEl.innerHTML = renderHtml(facts, explanation);
            wireActions(bodyEl, facts, explanation);
          });
        })
        .catch(function (err) { bodyEl.innerHTML = errorHtml(err && err.message); });
    });
  }

  root.PV_EXPLAIN = {
    openAssessment: openAssessment,
    // exposed for testing / reuse:
    assembleAssessmentFacts: assembleAssessmentFacts,
    fetchExplanation: fetchExplanation,
    renderHtml: renderHtml,
    docHtml: docHtml,
  };
}(typeof window !== 'undefined' ? window : this));
