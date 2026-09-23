import { describe, expect, it, beforeEach } from 'vitest';
import {
  useContextSectionsStore,
  setContextSectionsLive,
  clearContextSectionsLive,
  selectSkillsMemoryBytes,
  selectSkillsByName,
} from '../contextSectionsLive';
import {
  usePromptCacheLiveStore,
  setPromptCacheLive,
} from '../promptCacheLive';

describe('contextSectionsLive', () => {
  beforeEach(() => {
    useContextSectionsStore.setState({ bySession: {} });
    usePromptCacheLiveStore.setState({ bySession: {} });
  });

  it('reports nothing until the backend has emitted for that session', () => {
    expect(selectSkillsMemoryBytes(useContextSectionsStore.getState(), 'sess_a')).toBeNull();
  });

  it('sums the skills and memory blocks that were injected', () => {
    setContextSectionsLive('sess_a', {
      skillsBytes: 1200,
      memoryBytes: 800,
      stateBytes: 400,
      nudgeBytes: 0,
    });
    expect(selectSkillsMemoryBytes(useContextSectionsStore.getState(), 'sess_a')).toBe(2000);
  });

  it('keeps a zero as a measurement rather than dropping it', () => {
    // Auto-injection is off by default, so an all-zero turn is the common
    // case and is genuinely "nothing was injected" — distinct from the null
    // above, which means "we have not been told".
    setContextSectionsLive('sess_a', { skillsBytes: 0, memoryBytes: 0, stateBytes: 5, nudgeBytes: 0 });
    expect(selectSkillsMemoryBytes(useContextSectionsStore.getState(), 'sess_a')).toBe(0);
  });

  it('stays per-session so concurrent chats do not overwrite each other', () => {
    setContextSectionsLive('sess_a', { skillsBytes: 10 });
    setContextSectionsLive('sess_b', { skillsBytes: 999 });
    const state = useContextSectionsStore.getState();
    expect(selectSkillsMemoryBytes(state, 'sess_a')).toBe(10);
    expect(selectSkillsMemoryBytes(state, 'sess_b')).toBe(999);
  });

  it('ignores a malformed payload instead of writing NaN', () => {
    setContextSectionsLive('sess_a', undefined);
    setContextSectionsLive('sess_a', { skillsBytes: 'nonsense' as unknown as number });
    const state = useContextSectionsStore.getState();
    expect(state.bySession['sess_a'].skillsBytes).toBe(0);
    expect(Number.isNaN(state.bySession['sess_a'].skillsBytes)).toBe(false);
  });

  it('does not disturb the prompt-cache store, which drops empty updates', () => {
    // The cache store intentionally returns early when a turn has no cache
    // tokens. That rule must not be allowed to discard section sizes, which
    // is why they are separate stores — assert they stay independent.
    setPromptCacheLive('sess_a', { hitTokens: 8000, missTokens: 2000, hitRate: 0.8 });
    setContextSectionsLive('sess_a', { skillsBytes: 7, memoryBytes: 3 });
    expect(useContextSectionsStore.getState().bySession['sess_a']).toMatchObject({
      skillsBytes: 7,
      memoryBytes: 3,
    });
    expect(usePromptCacheLiveStore.getState().bySession['sess_a']).toMatchObject({
      hitTokens: 8000,
      missTokens: 2000,
    });
  });

  it('normalizes the per-skill map and keeps an absent session stable', () => {
    setContextSectionsLive('sess_a', {
      skillsBytes: 40,
      // Untrusted SSE payload: the store has to survive junk it was never
      // typed to receive.
      skillsByName: {
        canvas: 24,
        review: 0,
        ghost: -5,
        '': 9,
        weird: 'nope',
      } as unknown as Record<string, number>,
    });
    expect(selectSkillsByName(useContextSectionsStore.getState(), 'sess_a')).toEqual({
      canvas: 24,
    });
    // Stable identity: a selector handing back a fresh object every call would
    // re-render its subscribers on unrelated store writes.
    const empty = selectSkillsByName(useContextSectionsStore.getState(), 'sess_missing');
    expect(empty).toEqual({});
    expect(selectSkillsByName(useContextSectionsStore.getState(), 'sess_missing')).toBe(empty);
  });

  it('clears per session and entirely', () => {
    setContextSectionsLive('sess_a', { skillsBytes: 1 });
    setContextSectionsLive('sess_b', { skillsBytes: 2 });
    clearContextSectionsLive('sess_a');
    expect(selectSkillsMemoryBytes(useContextSectionsStore.getState(), 'sess_a')).toBeNull();
    expect(selectSkillsMemoryBytes(useContextSectionsStore.getState(), 'sess_b')).toBe(2);
    clearContextSectionsLive();
    expect(Object.keys(useContextSectionsStore.getState().bySession)).toEqual([]);
  });
});
