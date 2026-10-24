// The Admin Console's modules, in nav order (DIC-467; the registry moved from admin.js in
// DIC-2389). A module is either a Vue component, or (until it moves) drawn by admin.js:
// the shell takes its render(host) from window.PV_ADMIN_LEGACY.renderers.
import AccessOps from './modules/AccessOps.vue';
import CountyConfig from './modules/CountyConfig.vue';
import DataLayers from './modules/DataLayers.vue';
import Intelligence from './modules/Intelligence.vue';

export const MODULES = [
  { id: 'county', label: 'County Configuration', icon: '◆', component: CountyConfig },
  { id: 'intelligence', label: 'Intelligence', icon: '✦', component: Intelligence },
  { id: 'styling', label: 'Styling', icon: '◑' },
  { id: 'data', label: 'Data & Layers', icon: '▤', component: DataLayers },
  { id: 'access', label: 'Access & Ops', icon: '◈', component: AccessOps },
  { id: 'manifest', label: 'Theme Manifest', icon: '❖' },
];

/** The modules the shell can show: each Vue one, and each legacy one admin.js draws. */
export function resolveModules(renderers = {}) {
  return MODULES
    .map((m) => (m.component ? m : { ...m, render: renderers[m.id] }))
    .filter((m) => m.component || m.render);
}
