/* ── contextPressure warning gating regression ───────────────────────────
 * The backend emits a contextPressure SSE frame EVERY turn as a live
 * meter (workbench.py: "one emit per turn so the UI can show a live
 * server-accurate meter"). The composer previously rendered
 * "⚠️ Context window nearly full" for every frame — including fresh
 * sessions at ~0% used (reported as "999,805 tokens left of 1,000,000").
 * The warning must only appear when the server classifies pressure as
 * high/critical, or ≥75% used when the classification is missing. */

import { describe, expect, it } from 'vitest';
import { isContextPressured } from '../makeStreamHandlers';

describe('isContextPressured', () => {
  it('does not warn on a fresh session (low pressure, tiny usage)', () => {
    // The exact reported false alarm: 195 used of 1,000,000.
    expect(isContextPressured('low', 0.02)).toBe(false);
    expect(isContextPressured('medium', 62)).toBe(false);
  });

  it('warns on high/critical pressure', () => {
    expect(isContextPressured('high', 78)).toBe(true);
    expect(isContextPressured('critical', 91)).toBe(true);
    expect(isContextPressured('critical', undefined)).toBe(true);
  });

  it('falls back to pct only when the classification is missing', () => {
    expect(isContextPressured(undefined, 80)).toBe(true);
    expect(isContextPressured(undefined, 74.9)).toBe(false);
    expect(isContextPressured(undefined, undefined)).toBe(false);
  });
});
