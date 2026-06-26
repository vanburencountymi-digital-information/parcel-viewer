/**
 * doc.js — source-agnostic document/output utilities (A7b / DIC-573).
 *
 * The shared "render structured data to a printable/downloadable document" plumbing,
 * with NO domain knowledge and NO global reads (§4.1, §6.1):
 *   - print(html)               → print an HTML string (hidden iframe).
 *   - downloadHtml(html, name)  → download an HTML string as a self-contained file.
 *   - captureCanvasImage(handle)→ bake a map/canvas to a PNG data URL — the map handle
 *                                 is INJECTED by the caller, never read from a global.
 *
 * The viewer's domain-specific document layer (pv-doc.js) now delegates to this; its
 * record-specific templates + field mapping stay there as domain code.
 *
 * UMD: Node module (harness) + browser global (window.ISV_DOC).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_DOC = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Bake a map or canvas to a PNG data URL. `handle` is either a map instance
  // (anything with getCanvas()) or a canvas element (anything with toDataURL()).
  // Injected by the caller — this module never reaches for a global map handle.
  function captureCanvasImage(handle) {
    try {
      if (!handle) return null;
      if (typeof handle.getCanvas === 'function') {
        var c = handle.getCanvas();
        return c && c.toDataURL ? c.toDataURL('image/png') : null;
      }
      if (typeof handle.toDataURL === 'function') return handle.toDataURL('image/png');
    } catch (e) { /* tainted canvas / unsupported */ }
    return null;
  }

  function print(html) {
    var doc = (typeof document !== 'undefined') ? document : null;
    if (!doc) return;
    var f = doc.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    doc.body.appendChild(f);
    var d = f.contentWindow.document;
    d.open(); d.write(html); d.close();
    setTimeout(function () {
      try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) {}
      setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 1000);
    }, 300); // let any baked image paint before printing
  }

  function downloadHtml(html, filename) {
    var doc = (typeof document !== 'undefined') ? document : null;
    if (!doc) return;
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url; a.download = filename || 'document.html';
    doc.body.appendChild(a); a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  return { captureCanvasImage: captureCanvasImage, print: print, downloadHtml: downloadHtml };
}));
