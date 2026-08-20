/**
 * Per-session workstream attention counts for the session sidebar.
 *
 * A single /api/subagents/needs-attention poll (mounted in ChatLayout)
 * feeds this store; SessionRow renders an amber "needs handoff" dot from it.
 */
import { create } from 'zustand';

export interface NeedsAttentionInfo {
  needs: number;
  working: number;
}

interface NeedsAttentionState {
  bySession: Record<string, NeedsAttentionInfo>;
}

export const useNeedsHandoffStore = create<NeedsAttentionState>(() => ({
  bySession: {},
}));

/** Replace the whole map (the poll returns a full snapshot). */
export function setNeedsAttention(
  rows: Array<{ sessionId: string; needs: number; working: number }>,
): void {
  const bySession: Record<string, NeedsAttentionInfo> = {};
  for (const row of rows) {
    bySession[row.sessionId] = { needs: row.needs, working: row.working };
  }
  useNeedsHandoffStore.setState({ bySession });
}

/** Stable selector — returns undefined until data exists; the caller defaults. */
export function useNeedsAttention(sessionId: string | null): NeedsAttentionInfo | undefined {
  return useNeedsHandoffStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
}
