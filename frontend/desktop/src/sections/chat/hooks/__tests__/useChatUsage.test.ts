/* ── useChatUsage ────────────────────────────────────────────────────────
 * A single early/transient failure used to null the state outright and
 * leave the ContextRing on the bare local fallback (tool definitions only)
 * until the next turn flipped the refresh key. The hook now makes one
 * bounded retry before giving up.
 *
 * Real timers throughout: the retry fires at +1.2 s, so the waits here are
 * just past that. `waitFor` needs real timers to advance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useChatUsage } from '../useChatUsage';

const session = vi.fn();

vi.mock('@/api/usage', () => ({
  usageApi: { session: (...args: unknown[]) => session(...args) },
}));

const payload = {
  totalTokens: 100,
  totalInputTokens: 80,
  totalOutputTokens: 20,
  contextTokens: 9000,
  totalCost: 0.1,
  costEstimated: false,
  cacheHitTokens: 5,
  cacheMissTokens: 5,
  cacheHitRate: 0.5,
};

describe('useChatUsage', () => {
  beforeEach(() => {
    session.mockReset().mockResolvedValue(payload);
  });

  it('returns the session usage on a successful fetch', async () => {
    const { result } = renderHook(() => useChatUsage('s1', 'wb1'));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.contextTokens).toBe(9000);
    expect(session).toHaveBeenCalledTimes(1);
  });

  it('retries once after a transient failure', async () => {
    session
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(payload);
    const { result } = renderHook(() => useChatUsage('s1', 'wb1'));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.contextTokens).toBe(9000), { timeout: 4000 });
    expect(session).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second failure', async () => {
    session.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useChatUsage('s1', 'wb1'));
    await waitFor(() => expect(session).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(result.current).toBeNull();
  });
});
