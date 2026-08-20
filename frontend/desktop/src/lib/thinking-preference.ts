/* ── Thinking collapse preference ─────────────────────────────────────── */
/* When enabled, settled long thoughts render as a one-line summary with a  */
/* "Show full reasoning" affordance (dsh-style think row) instead of the    */
/* 9-line clamp. Persisted to localStorage; default on.                     */

const KEY = 'august.collapseThinking';

let cached: boolean | null = null;

export function isCollapseThinkingEnabled(): boolean {
  if (cached === null && typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(KEY);
      cached = raw === null ? true : raw === '1';
    } catch {
      cached = true;
    }
  }
  return cached ?? true;
}

export function setCollapseThinkingEnabled(value: boolean): void {
  cached = value;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(KEY, value ? '1' : '0');
    } catch {
      /* localStorage unavailable — preference is session-only */
    }
  }
}
