// Map Buddy's text helpers (moved from map-buddy.js in DIC-2389).
//
// The model returns Markdown (bold, bullet/numbered lists, paragraphs). This is a minimal,
// safe subset: HTML is escaped first, then a limited formatting set applied, with no
// raw-HTML passthrough, since LLM output is untrusted. Line-based so it's robust to the
// model's inconsistent blank lines: headings (#, or a line that's just a bold label) become
// subheads, bullet / numbered runs become lists, consecutive plain lines merge into one
// paragraph.

export function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Drops a leading icon or emoji: the chat reads cleaner without them. */
export function deIcon(s) { return String(s == null ? '' : s).replace(/^[^\w]+/, '').trim(); }

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>');
}

const isBreak = (s) => !s || /^(#{1,6}\s|[-*]\s|\d+\.\s)/.test(s) || /^\*\*[^*]+\*\*:?$/.test(s);

/** Markdown → HTML, every value escaped. */
export function renderMarkdown(text) {
  const src = escHtml(text).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!src) return '';
  const lines = src.split('\n');
  let html = '';
  let list = null;
  const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) { closeList(); continue; }
    const mH = raw.match(/^#{1,6}\s+(.*)$/);
    const mUL = raw.match(/^[-*]\s+(.*)$/);
    const mOL = raw.match(/^\d+\.\s+(.*)$/);
    if (mH || /^\*\*[^*]+\*\*:?$/.test(raw)) {
      closeList();
      html += '<div class="mb-h">' + inlineMd((mH ? mH[1] : raw).replace(/:$/, '')) + '</div>';
    } else if (mUL) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += '<li>' + inlineMd(mUL[1]) + '</li>';
    } else if (mOL) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += '<li>' + inlineMd(mOL[1]) + '</li>';
    } else {
      closeList();
      const para = [inlineMd(raw)];
      while (i + 1 < lines.length && !isBreak(lines[i + 1].trim())) para.push(inlineMd(lines[++i].trim()));
      html += '<p>' + para.join('<br>') + '</p>';
    }
  }
  closeList();
  return html;
}

/** "check_buildability" → "Check buildability". */
export function humanize(id) {
  const s = String(id || '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
