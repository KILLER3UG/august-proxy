/* ── ChatComposer — re-export shim (legacy component deleted, Phase 4) ── */
/* The 457-line legacy ChatComposer component + its internal ModelDropdown
 * were dead code (zero production usages — the composer lives in
 * ChatThreadComposer). This file survives ONLY as the stable import surface
 * for the context-breakdown helpers. The gauge that used to be re-exported
 * here was never mounted; its tests kept passing against it, so the file
 * below is the only trace it leaves. */

export type { ContextBreakdown } from './context-breakdown';
export { estimateContextBreakdown } from './context-breakdown';
