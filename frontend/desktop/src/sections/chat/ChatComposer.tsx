/* ── ChatComposer — re-export shim (legacy component deleted, Phase 4) ── */
/* The 457-line legacy ChatComposer component + its internal ModelDropdown
 * were dead code (zero production usages — the composer lives in
 * ChatThreadComposer). This file survives ONLY as the stable import surface
 * for ContextRing / ContextBreakdown / estimateContextBreakdown. */

export type { ContextBreakdown } from './context-breakdown';
export { estimateContextBreakdown } from './context-breakdown';
export { ContextRing } from './ContextRing';
