/**
 * browser-admin.js — the Admin Console page's engine entry (DIC-2180 slice 3).
 *
 * Same as browser.js, with only the hooks the console uses.
 */
import { adminHooks } from './window-hooks.js';

Object.assign(window, adminHooks);
