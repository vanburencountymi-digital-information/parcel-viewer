/**
 * pv-template.js — Shared HTML templating engine (DIC-372).
 *
 * A small, dependency-free Mustache-subset engine so per-parcel pages (Parcel
 * Packet, Tax/Assessment explainers, print/export) are assembled from a template
 * + structured data instead of ad-hoc string concatenation. Values are
 * HTML-escaped by default; raw output is explicit.
 *
 * Syntax:
 *   {{ name }}          escaped value (supports dotted paths: {{ a.b.c }})
 *   {{{ name }}} / {{& name }}   raw (unescaped) value
 *   {{# name }}…{{/ name }}      section: array → repeat per item; truthy → once;
 *                                falsy/empty → skip. Inside, {{.}} is the item.
 *   {{^ name }}…{{/ name }}      inverted section: render only when falsy/empty
 *   {{! comment }}      ignored
 *
 * Exposes: window.PV_TEMPLATE { render(template, data) -> html, escape(s) }
 */
(function (root) {
  'use strict';

  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Resolve a dotted key against a context stack (innermost scope first).
  function lookup(stack, key) {
    if (key === '.') return stack[stack.length - 1];
    var parts = key.split('.');
    for (var i = stack.length - 1; i >= 0; i--) {
      var ctx = stack[i];
      if (ctx == null || typeof ctx !== 'object') continue;
      if (!(parts[0] in ctx)) continue;            // first segment must exist in this scope
      var v = ctx;
      for (var j = 0; j < parts.length && v != null; j++) {
        v = (typeof v === 'object') ? v[parts[j]] : undefined;
      }
      return v;
    }
    return undefined;
  }

  function isEmpty(v) {
    return v == null || v === false || v === '' ||
      (Array.isArray(v) && v.length === 0);
  }

  var TAG = /\{\{\{\s*(.+?)\s*\}\}\}|\{\{\s*([!#^/&]?)\s*(.+?)\s*\}\}/g;

  // Parse a template string into a tree of text / var / raw / section nodes.
  function parse(tpl) {
    var root = { children: [] };
    var stack = [root];
    var last = 0, m;
    TAG.lastIndex = 0;
    function push(node) { stack[stack.length - 1].children.push(node); }
    while ((m = TAG.exec(tpl))) {
      if (m.index > last) push({ type: 'text', value: tpl.slice(last, m.index) });
      last = TAG.lastIndex;
      if (m[1] != null) { push({ type: 'raw', name: m[1] }); continue; }  // {{{x}}}
      var sigil = m[2], name = m[3];
      if (sigil === '!') continue;                                        // comment
      if (sigil === '&') { push({ type: 'raw', name: name }); continue; }
      if (sigil === '#' || sigil === '^') {
        var node = { type: 'section', inverted: sigil === '^', name: name, children: [] };
        push(node); stack.push(node);
      } else if (sigil === '/') {
        if (stack.length > 1) stack.pop();
      } else {
        push({ type: 'var', name: name });
      }
    }
    if (last < tpl.length) push({ type: 'text', value: tpl.slice(last) });
    return root;
  }

  function renderNode(node, stack) {
    var out = '';
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.type === 'text') { out += c.value; }
      else if (c.type === 'var') { out += escape(lookup(stack, c.name)); }
      else if (c.type === 'raw') { var rv = lookup(stack, c.name); out += (rv == null ? '' : String(rv)); }
      else if (c.type === 'section') {
        var v = lookup(stack, c.name);
        if (c.inverted) {
          if (isEmpty(v)) out += renderNode(c, stack);
        } else if (Array.isArray(v)) {
          for (var k = 0; k < v.length; k++) out += renderNode(c, stack.concat([v[k]]));
        } else if (!isEmpty(v)) {
          out += renderNode(c, stack.concat([v]));
        }
      }
    }
    return out;
  }

  function render(template, data) {
    return renderNode(parse(String(template == null ? '' : template)), [data || {}]);
  }

  root.PV_TEMPLATE = { render: render, escape: escape };
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this)));
