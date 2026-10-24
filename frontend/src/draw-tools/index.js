// The Drawing Tools pane as a Vue island (DIC-2389): mounts into #mcp-pane-draw. The map
// side stays drawing/drawing-tools.js (PS_DRAWING_TOOLS), with the annotation store, undo
// and snapping modules beside it.
import { createApp } from 'vue';
import * as viewer from '../shared/viewer.js';
import DrawTools from './DrawTools.vue';

export function mountDrawTools(doc = document) {
  const pane = doc.getElementById('mcp-pane-draw');
  const tools = viewer.drawTools();
  if (!pane || !tools) return null;      // no pane on this page, or the drawing scripts didn't load
  // Mounting replaces the pane's children; its own attributes (hidden, role) stay the panel's.
  return createApp(DrawTools, {
    tools,
    annotations: viewer.annotations(),
    undo: viewer.undoRedo(),
    snapping: viewer.snapping(),
  }).mount(pane);
}
