/**
 * pv-context-menu.js — the map's right-click menu (DIC-1882).
 *
 * Opens at the pointer on right-click, on a long press (touch), or at the map center
 * with the Menu key / Shift+F10 when the map has focus. Offers:
 *   - Copy coordinates of that point in several formats (pv-coords.js; each row shows
 *     exactly what it copies);
 *   - Select the parcel here, Center the map here, Open in Google Maps, Street View here.
 *
 * Keyboard: focus moves into the menu; ↑/↓/Home/End move, Enter/Space activate, Esc or
 * Tab close (focus returns to the map). A right-drag (map rotate) never opens it.
 *
 * Exposes window.PV_CONTEXT_MENU = { openAt(point), close(), isOpen() } for tests and
 * other modules. Load after map.js and pv-coords.js.
 */
(function (root) {
  'use strict';

  var doc = root.document;
  var MENU_ID = 'pv-ctx-menu';
  var LONG_PRESS_MS = 550;
  var DRAG_TOLERANCE_PX = 5;

  var menuEl = null;          // the open menu's wrapper, or null
  var openedAt = null;        // { lngLat, point }
  var rightDownAt = null;     // client xy of the last right-button press (drag detection)
  var toastTimer = null;

  function getMap() { return root.PS_MAP || null; }
  function mapContainer() { return doc.getElementById('map'); }

  // ── Actions ────────────────────────────────────────────────────────────────
  function parcelIdAt(map, point) {
    try {
      if (!map.getLayer('parcels-fill')) return null;
      var hits = map.queryRenderedFeatures([point.x, point.y], { layers: ['parcels-fill'] });
      var id = hits.length && hits[0].properties ? hits[0].properties.id : null;
      return id == null ? null : id;
    } catch (_) { return null; }
  }

  function googleMapsUrl(ll) {
    return 'https://www.google.com/maps/search/?api=1&query=' + ll.lat.toFixed(6) + ',' + ll.lng.toFixed(6);
  }
  function streetViewUrl(ll) {
    return 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + ll.lat.toFixed(6) + ',' + ll.lng.toFixed(6);
  }

  function copyText(text) {
    function fallback() {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.top = '0';
      doc.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (_) { ok = false; }
      doc.body.removeChild(ta);
      return ok;
    }
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      return root.navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }

  function toast(msg) {
    var old = doc.querySelector('.pv-ctx-toast');
    if (old) old.remove();
    if (toastTimer) clearTimeout(toastTimer);
    var t = doc.createElement('div');
    t.className = 'pv-toast pv-ctx-toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    doc.body.appendChild(t);
    root.requestAnimationFrame(function () { t.classList.add('pv-toast--show'); });
    toastTimer = setTimeout(function () {
      t.classList.remove('pv-toast--show');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, 2600);
  }

  // ── Building the menu ──────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function item(label, detail, onPick, id) {
    var b = el('button', 'pv-ctx-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    if (id) b.setAttribute('data-ctx', id);
    b.appendChild(el('span', 'pv-ctx-label', label));
    if (detail) b.appendChild(el('span', 'pv-ctx-detail', detail));
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      onPick();
    });
    return b;
  }

  function group(labelText, items) {
    var g = el('div', 'pv-ctx-group');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', labelText);
    var h = el('div', 'pv-ctx-group-label', labelText);
    h.setAttribute('aria-hidden', 'true');
    g.appendChild(h);
    items.forEach(function (i) { g.appendChild(i); });
    return g;
  }

  function build(map, ll, point) {
    var fmt = root.PV_COORD_FMT;
    var wrap = el('div', 'pv-ctx');
    wrap.id = MENU_ID;

    var head = el('div', 'pv-ctx-head');
    head.id = MENU_ID + '-head';
    var current = root.PV_COORDS && root.PV_COORDS.getFormat ? root.PV_COORDS.getFormat() : 'dd';
    head.textContent = fmt.readout(ll, current);
    wrap.appendChild(head);

    var menu = el('div', 'pv-ctx-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', head.id);

    var copyItems = fmt.copyRows(ll).map(function (row) {
      return item(row.label, row.text, function () {
        close(true);
        copyText(row.text).then(function (ok) {
          toast(ok ? 'Copied ' + row.text : 'Couldn’t copy. Your browser blocked the clipboard.');
        });
      }, 'copy-' + row.id);
    });
    menu.appendChild(group('Copy coordinates', copyItems));

    var sep = el('div', 'pv-ctx-sep');
    sep.setAttribute('role', 'separator');
    menu.appendChild(sep);

    var actions = [];
    var parcelId = parcelIdAt(map, point);
    if (parcelId != null && root.PS_selectParcelById) {
      actions.push(item('Select the parcel here', null, function () {
        close(true);
        root.PS_selectParcelById(parcelId, { keepView: true });
      }, 'select'));
    }
    actions.push(item('Center the map here', null, function () {
      close(true);
      map.easeTo({ center: [ll.lng, ll.lat], duration: 500 });
    }, 'center'));
    actions.push(item('Open in Google Maps', null, function () {
      close(true);
      root.open(googleMapsUrl(ll), '_blank', 'noopener');
    }, 'google-maps'));
    actions.push(item('Street View here', null, function () {
      close(true);
      root.open(streetViewUrl(ll), '_blank', 'noopener');
    }, 'street-view'));
    menu.appendChild(group('Actions', actions));

    wrap.appendChild(menu);
    return wrap;
  }

  // ── Open / close ───────────────────────────────────────────────────────────
  function items() { return menuEl ? Array.prototype.slice.call(menuEl.querySelectorAll('[role="menuitem"]')) : []; }
  function focusItem(i) {
    var list = items();
    if (!list.length) return;
    var n = ((i % list.length) + list.length) % list.length;
    list.forEach(function (b, j) { b.tabIndex = j === n ? 0 : -1; });
    list[n].focus();
  }

  function position(wrap, clientX, clientY) {
    var vw = root.innerWidth, vh = root.innerHeight, pad = 8;
    var r = wrap.getBoundingClientRect();
    var x = clientX, y = clientY;
    if (x + r.width + pad > vw) x = Math.max(pad, vw - r.width - pad);
    // Below the point if it fits, else above it, else as low as it fits (so it stays
    // next to the point on a short screen).
    if (y + r.height + pad > vh) {
      y = clientY - r.height >= pad ? clientY - r.height : Math.max(pad, vh - r.height - pad);
    }
    wrap.style.left = Math.round(x) + 'px';
    wrap.style.top = Math.round(y) + 'px';
  }

  // point: pixel position within the map canvas.
  function openAt(point) {
    var map = getMap();
    var container = mapContainer();
    if (!map || !container || !root.PV_COORD_FMT) return false;
    close(false);
    // A search arrival's fly-in/orbit would move the map and close the menu at once.
    if (root.PS_cancelCinematic) root.PS_cancelCinematic();
    var ll = map.unproject([point.x, point.y]);
    openedAt = { lngLat: ll, point: point };
    menuEl = build(map, ll, point);
    menuEl.style.left = '-9999px';
    menuEl.style.top = '0px';
    doc.body.appendChild(menuEl);
    var rect = container.getBoundingClientRect();
    position(menuEl, rect.left + point.x, rect.top + point.y);
    menuEl.addEventListener('keydown', onMenuKey);
    focusItem(0);
    doc.addEventListener('pointerdown', onOutsidePointer, true);
    root.addEventListener('resize', onDismiss);
    root.addEventListener('blur', onDismiss);
    map.on('movestart', onDismiss);
    return true;
  }

  function close(returnFocus) {
    if (!menuEl) return;
    var map = getMap();
    menuEl.removeEventListener('keydown', onMenuKey);
    if (menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    openedAt = null;
    doc.removeEventListener('pointerdown', onOutsidePointer, true);
    root.removeEventListener('resize', onDismiss);
    root.removeEventListener('blur', onDismiss);
    if (map) map.off('movestart', onDismiss);
    if (returnFocus && map && map.getCanvas) {
      try { map.getCanvas().focus({ preventScroll: true }); } catch (_) {}
    }
  }

  function onDismiss() { close(false); }
  function onOutsidePointer(e) {
    if (menuEl && !menuEl.contains(e.target)) close(false);
  }

  function onMenuKey(e) {
    var list = items();
    var i = list.indexOf(doc.activeElement);
    switch (e.key) {
      case 'ArrowDown': focusItem(i + 1); break;
      case 'ArrowUp': focusItem(i < 0 ? -1 : i - 1); break;
      case 'Home': focusItem(0); break;
      case 'End': focusItem(-1); break;
      case 'Escape': close(true); break;
      case 'Tab': close(true); break;
      default: return;   // Enter/Space activate the focused button natively
    }
    e.preventDefault();
    e.stopPropagation();   // keep Escape from also clearing the parcel selection
  }

  // ── Triggers ───────────────────────────────────────────────────────────────
  function centerPoint(container) {
    var r = container.getBoundingClientRect();
    return { x: r.width / 2, y: r.height / 2 };
  }

  function wire(container) {
    // Remember where the right button went down, so a right-drag (rotate) is ignored.
    container.addEventListener('mousedown', function (e) {
      if (e.button === 2) rightDownAt = { x: e.clientX, y: e.clientY };
    }, true);

    container.addEventListener('contextmenu', function (e) {
      e.preventDefault();   // never the browser's own menu over the map
      if (!getMap()) return;
      var r = container.getBoundingClientRect();
      // The Menu key / Shift+F10 fire contextmenu with no pointer (pointerType "" in
      // Chromium, button 0 elsewhere); a touch long press has pointerType "touch".
      var pt = e.pointerType;
      var fromKeyboard = pt === '' || (e.button !== 2 && pt !== 'touch' && pt !== 'pen');
      if (fromKeyboard) { openAt(centerPoint(container)); return; }
      if (rightDownAt && Math.hypot(e.clientX - rightDownAt.x, e.clientY - rightDownAt.y) > DRAG_TOLERANCE_PX) {
        rightDownAt = null;
        return;   // that was a rotate/pitch drag
      }
      rightDownAt = null;
      openAt({ x: e.clientX - r.left, y: e.clientY - r.top });
    });

    // Long press on touch (iOS Safari never fires contextmenu for touch).
    var pressTimer = null, pressStart = null;
    function cancelPress() { if (pressTimer) clearTimeout(pressTimer); pressTimer = null; pressStart = null; }
    container.addEventListener('touchstart', function (e) {
      cancelPress();
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      pressStart = { x: t.clientX, y: t.clientY };
      pressTimer = setTimeout(function () {
        pressTimer = null;
        if (!pressStart || menuEl) return;
        var r = container.getBoundingClientRect();
        openAt({ x: pressStart.x - r.left, y: pressStart.y - r.top });
      }, LONG_PRESS_MS);
    }, { passive: true });
    container.addEventListener('touchmove', function (e) {
      if (!pressStart) return;
      var t = e.touches[0];
      if (e.touches.length !== 1 || Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) > DRAG_TOLERANCE_PX * 2) cancelPress();
    }, { passive: true });
    container.addEventListener('touchend', cancelPress, { passive: true });
    container.addEventListener('touchcancel', cancelPress, { passive: true });

    // Shift+F10 on the focused map (some browsers don't turn it into contextmenu).
    container.addEventListener('keydown', function (e) {
      if (e.key === 'F10' && e.shiftKey && getMap()) {
        e.preventDefault();
        openAt(centerPoint(container));
      }
    });
  }

  function init() {
    var container = mapContainer();
    if (container) wire(container);
  }

  root.PV_CONTEXT_MENU = {
    openAt: openAt,
    close: function () { close(false); },
    isOpen: function () { return !!menuEl; },
    lastLngLat: function () { return openedAt ? openedAt.lngLat : null; },
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
