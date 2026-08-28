import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  __resetVerboseModeForTests,
  isVerboseMode,
  setVerboseMode,
  toggleVerboseMode,
  useVerboseMode,
} from '../verbose-mode';

afterEach(() => {
  __resetVerboseModeForTests();
});

describe('verbose-mode store (plan §4.2)', () => {
  it('starts off for every session', () => {
    expect(isVerboseMode('sess-1')).toBe(false);
    expect(isVerboseMode(null)).toBe(false);
    expect(isVerboseMode(undefined)).toBe(false);
  });

  it('set/toggle are per-session', () => {
    setVerboseMode('sess-1', true);
    expect(isVerboseMode('sess-1')).toBe(true);
    expect(isVerboseMode('sess-2')).toBe(false);

    // Toggle flips only the addressed session.
    expect(toggleVerboseMode('sess-2')).toBe(true);
    expect(isVerboseMode('sess-1')).toBe(true);
    expect(isVerboseMode('sess-2')).toBe(true);
    expect(toggleVerboseMode('sess-1')).toBe(false);
    expect(isVerboseMode('sess-1')).toBe(false);
    expect(isVerboseMode('sess-2')).toBe(true);
  });

  it('ignores empty session ids', () => {
    setVerboseMode('', true);
    expect(toggleVerboseMode(null)).toBe(false);
    expect(isVerboseMode('')).toBe(false);
  });
});

describe('useVerboseMode', () => {
  it('re-renders when the session flag flips', () => {
    const { result } = renderHook(() => useVerboseMode('sess-1'));
    expect(result.current).toBe(false);

    act(() => {
      setVerboseMode('sess-1', true);
    });
    expect(result.current).toBe(true);

    act(() => {
      toggleVerboseMode('sess-1');
    });
    expect(result.current).toBe(false);
  });

  it('does not react to other sessions', () => {
    const { result } = renderHook(() => useVerboseMode('sess-1'));
    act(() => {
      setVerboseMode('sess-2', true);
    });
    expect(result.current).toBe(false);
  });
});
