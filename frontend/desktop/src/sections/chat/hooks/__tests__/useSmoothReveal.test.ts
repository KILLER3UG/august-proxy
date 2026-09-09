/* ── useSmoothReveal — character-level streaming reveal ─────────────────── */
/* The burst→smooth fix for streamed answers: text arrives in ~64-char SSE
 * chunks but must PAINT progressively. These tests drive requestAnimationFrame
 * with fake timers and assert the revealed prefix advances toward the target
 * and never lags a burst by more than the catch-up window. */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSmoothReveal } from '../useSmoothReveal';

function flushFrames(n: number) {
  for (let i = 0; i < n; i++) {
    act(() => {
      vi.advanceTimersByTime(16);
    });
  }
}

describe('useSmoothReveal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the full target when inactive (settled block)', () => {
    const { result } = renderHook(() => useSmoothReveal('a complete answer', false));
    expect(result.current).toBe('a complete answer');
  });

  it('reveals progressively and catches up with a burst', () => {
    const burst = 'x'.repeat(200);
    const { result, rerender } = renderHook(
      ({ text, live }) => useSmoothReveal(text, live),
      { initialProps: { text: burst.slice(0, 10), live: true } },
    );
    // First chunk paints immediately (TTFT).
    expect(result.current).toBe(burst.slice(0, 10));

    // A 190-char burst arrives at once — the reveal must NOT dump it whole.
    rerender({ text: burst, live: true });
    flushFrames(2);
    expect(result.current.length).toBeLessThan(burst.length);
    expect(result.current.length).toBeGreaterThan(10);

    // Within the catch-up window the reveal must fully converge. The rate is
    // proportional (ease-out), so allow a generous frame budget.
    flushFrames(60);
    expect(result.current).toBe(burst);
  });

  it('clamps down immediately when the target shrinks (retry rollback)', () => {
    const long = 'y'.repeat(120);
    const { result, rerender } = renderHook(
      ({ text, live }) => useSmoothReveal(text, live),
      { initialProps: { text: long, live: true } },
    );
    flushFrames(15);
    expect(result.current).toBe(long);
    rerender({ text: 'short', live: true });
    flushFrames(2);
    expect(result.current).toBe('short');
  });

  it('flips to the full text the moment streaming ends', () => {
    const text = 'z'.repeat(300);
    const { result, rerender } = renderHook(
      ({ text, live }) => useSmoothReveal(text, live),
      { initialProps: { text: text.slice(0, 50), live: true } },
    );
    rerender({ text, live: true });
    flushFrames(1);
    const mid = result.current.length;
    expect(mid).toBeLessThan(text.length);
    rerender({ text, live: false });
    expect(result.current).toBe(text);
  });
});
