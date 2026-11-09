import { verificationCadence, verificationCadences } from './verification.mjs';
import { contextLimit, validateContextLimit } from './context-rollover.mjs';

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
// Graphite is the warm dark that earlier versions called Dark and keeps its saved key, so a saved choice never changes
// meaning; Dark is the near-black palette. System follows the OS between Light and Dark until a choice is saved.
export const appearances = ['system', 'light', 'dark', 'graphite'];
export const appearance = config => appearances.includes(config.appearance) ? config.appearance : 'system';
// view is the layout setup chose for new workspaces: Normal (every panel, manual choices) or Flow (routed, cards).
export const defaultPreferences = { provider: 'codex', model: null, effort: null, mode: 'edit', billing: 'subscription', view: 'normal' };
export function preferencePatch(input, previous = {}) {
  const patch = {};
  if (input.contextLimit !== undefined) patch.contextLimit = validateContextLimit(input.contextLimit);
  if (input.verificationCadence !== undefined) {
    if (!verificationCadences.includes(input.verificationCadence)) fail('Choose As needed or Review first for testing.');
    patch.verificationCadence = input.verificationCadence;
  }
  if (input.theme !== undefined) {
    if (!appearances.includes(input.theme)) fail('Choose System, Light, Dark or Graphite.');
    patch.appearance = input.theme;
  }
  if (input.defaults !== undefined) {
    const value = input.defaults;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Choose valid assistant defaults.');
    const next = { ...defaultPreferences, ...previous.defaults };
    for (const key of Object.keys(defaultPreferences)) if (value[key] !== undefined) next[key] = value[key];
    if (!['codex', 'claude', 'gemini'].includes(next.provider) || !['read', 'edit'].includes(next.mode) || !['subscription', 'api'].includes(next.billing)) fail('Choose a supported assistant, access level and billing preference.');
    if (!['normal', 'flow'].includes(next.view)) fail('Choose Normal or Flow.');
    if (next.model !== null && (typeof next.model !== 'string' || !next.model.trim() || next.model.length > 200)) fail('Choose a model or Provider default.');
    if (next.effort !== null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(next.effort)) fail('Choose a supported effort or Provider default.');
    patch.defaults = next;
  }
  if (input.onboarding !== undefined) {
    const value = input.onboarding;
    if (!value || typeof value !== 'object' || !Number.isInteger(value.step) || value.step < 0 || value.step > 3) fail('Choose a valid setup step.');
    patch.onboarding = { ...previous.onboarding, step: value.step, dismissed: value.dismissed === true };
    if (value.completed === true) patch.onboarding.completedAt = new Date().toISOString();
  }
  return patch;
}
export function publicPreferences(config, hasProjects) {
  return { defaults: { ...defaultPreferences, ...config.defaults }, theme: appearance(config), verificationCadence: verificationCadence(config), contextLimit: contextLimit(config), onboarding: config.onboarding || { step: 0 }, firstRun: !hasProjects && !config.onboarding?.completedAt && !config.onboarding?.dismissed };
}
