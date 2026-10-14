// A transient status message at the bottom of the map, in the AI-mode toast style
// (.pv-toast in style.css). Announced politely (role="status").
export function toast(msg, doc = globalThis.document) {
  if (!doc) return;
  const t = doc.createElement('div');
  t.className = 'pv-toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  (doc.body || doc.documentElement).appendChild(t);
  const raf = globalThis.requestAnimationFrame;
  if (raf) raf(() => t.classList.add('pv-toast--show'));
  else t.classList.add('pv-toast--show');
  setTimeout(() => {
    t.classList.remove('pv-toast--show');
    setTimeout(() => t.remove(), 320);
  }, 2600);
}
