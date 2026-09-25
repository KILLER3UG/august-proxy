/* ── contextLive store ──────────────────────────────────────────────────
 * The contextPressure SSE event carries the server-accurate occupancy
 * measurement (totalTokens / maxContext). It used to be destructured and
 * discarded in makeStreamHandlers, which left the ring on the persisted
 * usage value. Keyed per session, ignores incomplete payloads.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useContextLiveStore,
  setContextLive,
  clearContextLive,
  selectContextLive,
} from '../contextLive';

describe('contextLive store', () => {
  beforeEach(() => {
    clearContextLive();
  });

  it('stores the server measurement per session', () => {
    setContextLive('sess_a', { totalTokens: 42000, maxContext: 200000, contextUsedPct: 21 });
    setContextLive('sess_b', { totalTokens: 1000, maxContext: 128000 });
    const a = selectContextLive(useContextLiveStore.getState(), 'sess_a');
    const b = selectContextLive(useContextLiveStore.getState(), 'sess_b');
    expect(a).toMatchObject({ totalTokens: 42000, maxContext: 200000, usedPct: 21 });
    expect(b).toMatchObject({ totalTokens: 1000, maxContext: 128000, usedPct: 0 });
  });

  it('ignores incomplete or missing payloads', () => {
    setContextLive('sess_a', undefined);
    setContextLive('sess_a', { totalTokens: 0, maxContext: 0 });
    setContextLive('sess_a', { totalTokens: 500, maxContext: 0 });
    expect(selectContextLive(useContextLiveStore.getState(), 'sess_a')).toBeNull();
  });

  it('overwrites with the newest turn event', () => {
    setContextLive('sess_a', { totalTokens: 100, maxContext: 128000 });
    setContextLive('sess_a', { totalTokens: 900, maxContext: 128000, contextUsedPct: 70 });
    const entry = selectContextLive(useContextLiveStore.getState(), 'sess_a');
    expect(entry?.totalTokens).toBe(900);
    expect(entry?.usedPct).toBe(70);
  });

  it('clears one session without touching the others', () => {
    setContextLive('sess_a', { totalTokens: 1, maxContext: 128000 });
    setContextLive('sess_b', { totalTokens: 2, maxContext: 128000 });
    clearContextLive('sess_a');
    expect(selectContextLive(useContextLiveStore.getState(), 'sess_a')).toBeNull();
    expect(selectContextLive(useContextLiveStore.getState(), 'sess_b')).not.toBeNull();
  });
});
