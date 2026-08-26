/* ── Thinking expand persistence (user-requested behavior) ──────────────
 * The thinking block must ONLY close when:
 *   1. the user manually closes it, or
 *   2. the final response starts generating.
 * Mid-turn streaming gaps (workbench tool rounds pause the stream) must
 * NOT wipe manual expansion.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useState, useEffect } from 'react';

/**
 * Extract + exercise the exact override-reset contract from
 * AssistantBlockTimeline: overrides persist until `hasFinalOutput` flips
 * true. Rendered here as a mirror of the component's effect so a future
 * edit that reintroduces mid-turn resets fails this test loudly.
 */
function useExpandContract(hasFinalOutput: boolean) {
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (hasFinalOutput) {
      setExpandOverrides({});
    }
  }, [hasFinalOutput]);
  const toggleExpand = (id: string, next: boolean) =>
    setExpandOverrides((prev) => ({ ...prev, [id]: next }));
  return { expandOverrides, toggleExpand };
}

describe('thinking expand persistence', () => {
  it('keeps manual expansion across streaming pauses', () => {
    const { result, rerender } = renderHook(
      ({ final }) => useExpandContract(final),
      { initialProps: { final: false } },
    );
    // User expands a thought mid-stream…
    act(() => result.current.toggleExpand('think_1', true));
    expect(result.current.expandOverrides['think_1']).toBe(true);
    // …the stream pauses between tool rounds (streaming false→true flickers,
    // but hasFinalOutput stays false) — expansion MUST survive.
    rerender({ final: false });
    rerender({ final: false });
    expect(result.current.expandOverrides['think_1']).toBe(true);
  });

  it('closes thoughts when the final response generates', () => {
    const { result, rerender } = renderHook(
      ({ final }) => useExpandContract(final),
      { initialProps: { final: false } },
    );
    act(() => result.current.toggleExpand('think_1', true));
    expect(result.current.expandOverrides['think_1']).toBe(true);
    // Final answer block arrives → overrides reset.
    rerender({ final: true });
    expect(result.current.expandOverrides['think_1']).toBeUndefined();
  });

  it('does not resurrect overrides after the reset (no stale re-apply)', () => {
    const { result, rerender } = renderHook(
      ({ final }) => useExpandContract(final),
      { initialProps: { final: false } },
    );
    act(() => result.current.toggleExpand('a', true));
    rerender({ final: true });
    expect(result.current.expandOverrides).toEqual({});
    rerender({ final: true });
    expect(result.current.expandOverrides).toEqual({});
  });
});

/** Source-level guard: the reset effect must key on hasFinalOutput only. */
describe('AssistantBlockTimeline source contract', () => {
  it('reset effect references hasFinalOutput, never !streaming', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.resolve(
      __dirname,
      '../AssistantBlockTimeline.tsx',
    );
    const src = fs.readFileSync(file, 'utf-8');
    // The old buggy effect keyed on (!streaming && hasFinalOutput) and wiped
    // overrides on every tool-round pause. It must stay gone.
    expect(src).not.toMatch(/!streaming && hasFinalOutput[\s\S]{0,80}setExpandOverrides\(\{\}\)/);
    // The surviving reset keys on hasFinalOutput alone.
    expect(src).toMatch(/if \(hasFinalOutput\) \{\s*\n\s*setExpandOverrides\(\{\}\);/);
  });
});
