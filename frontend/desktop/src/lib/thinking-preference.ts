/* ── Thinking collapse preference ─────────────────────────────────────── */
/* When enabled (the DEFAULT), settled thoughts render as a one-line        */
/* distilled "what the model is doing" header with a "Show full reasoning"  */
/* affordance (Claude-style step rows) instead of clamped raw prose.        */
/* Persisted to localStorage; an explicit opt-out ('0') restores the old    */
/* multi-line clamp + "Show more" raw-prose rendering.                      */

const KEY = 'august.collapseThinking';

let cached: boolean | null = null;

export function isCollapseThinkingEnabled(): boolean {
  if (cached === null && typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(KEY);
      // Default ON: Claude-style summary rows out of the box. An explicit
      // '0' is the only way back to raw prose rendering.
      cached = raw !== '0';
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
