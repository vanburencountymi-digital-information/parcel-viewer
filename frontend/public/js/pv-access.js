/**
 * pv-access.js — the data-access notices (ADR 0015, DIC-2198).
 *
 * In a Protected county the parcel API stops sending owner and value fields once a visitor
 * has used the day's budget of detailed records. Each such parcel row carries
 * `details_withheld`, and the response carries `detail_budget` (limit, used, resets_at,
 * data_url, terms_url). This module:
 *   - note(json): every parcel fetch passes its parsed response through it; the first time
 *     anything is withheld, a persistent, dismissible notice explains it (once per page);
 *   - isWithheld(props): whether one parcel's details were withheld, so the UI can say
 *     "withheld" instead of "none on record";
 *   - countyAccess(): the county's access block (mode, dataUrl, termsUrl) for the About dialog.
 * Open counties never send the flags, so none of this ever shows for them.
 *
 * Exposes window.PV_ACCESS. Load before map.js.
 */
(function (root) {
  'use strict';

  var doc = root.document;
  var NOTICE_ID = 'pv-access-notice';
  var WITHHELD_LABEL = 'Withheld today (daily detail limit)';
  var state = { withheld: false, budget: null, dismissed: false };

  function isWithheld(props) {
    return !!(props && props.details_withheld);
  }

  function safeUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  }

  function resetText(iso) {
    var when = new Date(iso);
    if (!iso || isNaN(when)) return '';
    return when.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function countyAccess() {
    var cfg = (root.PS_CONTEXT && root.PS_CONTEXT.config) || root.COUNTY || {};
    return cfg.access || {};
  }

  function link(text, href) {
    var a = doc.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    return a;
  }

  function render() {
    if (!state.withheld || state.dismissed || !doc.body) return;
    var el = doc.getElementById(NOTICE_ID);
    if (!el) {
      el = doc.createElement('div');
      el.id = NOTICE_ID;
      el.className = 'pv-access-notice';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.dataset.testid = 'pv-access-notice';
      doc.body.appendChild(el);
    }
    var budget = state.budget || {};
    var when = resetText(budget.resets_at);
    el.textContent = '';

    var text = doc.createElement('p');
    text.textContent = 'You’ve reached today’s limit for owner and value details. ' +
      'The map, parcel shapes and search keep working' +
      (when ? '; full details return ' + when + '.' : '.');
    el.appendChild(text);

    var dataUrl = safeUrl(budget.data_url) || safeUrl(countyAccess().dataUrl);
    var termsUrl = safeUrl(budget.terms_url) || safeUrl(countyAccess().termsUrl);
    if (dataUrl || termsUrl) {
      var links = doc.createElement('p');
      links.className = 'pv-access-links';
      if (dataUrl) links.appendChild(link('Get the full dataset from the county', dataUrl));
      if (dataUrl && termsUrl) links.appendChild(doc.createTextNode(' · '));
      if (termsUrl) links.appendChild(link('Terms of use', termsUrl));
      el.appendChild(links);
    }

    var close = doc.createElement('button');
    close.type = 'button';
    close.className = 'pv-access-close';
    close.setAttribute('aria-label', 'Dismiss the data limit notice');
    close.textContent = '×';
    close.addEventListener('click', function () {
      state.dismissed = true;
      el.remove();
    });
    el.appendChild(close);
  }

  // Takes a parsed parcel API response. Returns it unchanged, after noting any withholding.
  function note(json) {
    if (json && json.details_withheld) {
      var first = !state.withheld;
      state.withheld = true;
      state.budget = json.detail_budget || state.budget;
      render();
      if (first) doc.dispatchEvent(new CustomEvent('pv:details-withheld', { detail: state.budget }));
    }
    return json;
  }

  root.PV_ACCESS = {
    note: note,
    isWithheld: isWithheld,
    countyAccess: countyAccess,
    WITHHELD_LABEL: WITHHELD_LABEL,
    getState: function () { return { withheld: state.withheld, budget: state.budget }; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
