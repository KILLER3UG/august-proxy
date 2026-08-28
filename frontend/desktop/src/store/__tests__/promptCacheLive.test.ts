/* ── promptCacheLive store (Bug 9a) ────────────────────────────────────
 * contextPressure SSE events feed the ContextRing through this store;
 * keyed per session, ignores empty payloads, clearable per session.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  usePromptCacheLiveStore,
  setPromptCacheLive,
  clearPromptCacheLive,
  selectPromptCacheLive,
} from '../promptCacheLive';

describe('promptCacheLive store', () => {
  beforeEach(() => {
    clearPromptCacheLive();
  });

  it('stores cache stats per session', () => {
    setPromptCacheLive('sess_a', { hitTokens: 8000, missTokens: 2000, hitRate: 0.8 });
    setPromptCacheLive('sess_b', { hitTokens: 100, missTokens: 900 });
    const a = selectPromptCacheLive(usePromptCacheLiveStore.getState(), 'sess_a');
    const b = selectPromptCacheLive(usePromptCacheLiveStore.getState(), 'sess_b');
    expect(a).toMatchObject({ hitTokens: 8000, missTokens: 2000, hitRate: 0.8 });
    expect(b).toMatchObject({ hitTokens: 100, missTokens: 900, hitRate: undefined });
  });

  it('ignores empty or missing payloads', () => {
    setPromptCacheLive('sess_a', undefined);
    setPromptCacheLive('sess_a', { hitTokens: 0, missTokens: 0 });
    expect(selectPromptCacheLive(usePromptCacheLiveStore.getState(), 'sess_a')).toBeNull();
  });

  it('overwrites with the newest turn event', () => {
    setPromptCacheLive('sess_a', { hitTokens: 100, missTokens: 100 });
    setPromptCacheLive('sess_a', { hitTokens: 500, missTokens: 500, hitRate: 0.5 });
    const entry = selectPromptCacheLive(usePromptCacheLiveStore.getState(), 'sess_a');
    expect(entry?.hitTokens).toBe(500);
    expect(entry?.hitRate).toBe(0.5);
  });

  it('clears one session without touching the others', () => {
    setPromptCacheLive('sess_a', { hitTokens: 1, missTokens: 1 });
    setPromptCacheLive('sess_b', { hitTokens: 2, missTokens: 2 });
    clearPromptCacheLive('sess_a');
    expect(selectPromptCacheLive(usePromptCacheLiveStore.getState(), 'sess_a')).toBeNull();
    expect(selectPromptCacheLive(usePromptCacheLiveStore.getState(), 'sess_b')).not.toBeNull();
  });
});
