/**
 * Per-session store for pending sub-agent breakdown proposals.
 *
 * The backend emits `subagentProposed` when a model uses
 * spawn_subagents(mode='proposed') — the user must approve before workers
 * start. The SubagentProposalBar renders Launch/Reject; decisions go to
 * POST /api/subagents/propose-breakdown (the Runs tab list shares the same
 * pending proposals, so it stays consistent).
 */
import { create } from 'zustand';

export interface SubagentProposal {
  proposalId: string;
  workBreakdown: Array<{ goal?: string; agentId?: string }>;
  at: number;
}

interface SubagentProposalsState {
  bySession: Record<string, SubagentProposal>;
}

export const useSubagentProposalsStore = create<SubagentProposalsState>(() => ({
  bySession: {},
}));

export const $subagentProposals = {
  get: (): Record<string, SubagentProposal> => useSubagentProposalsStore.getState().bySession,
  subscribe: (listener: (bySession: Record<string, SubagentProposal>) => void): (() => void) => {
    listener(useSubagentProposalsStore.getState().bySession);
    return useSubagentProposalsStore.subscribe((s) => listener(s.bySession));
  },
};

/** Register (or replace) a pending proposal for a session. */
export function setSubagentProposal(
  sessionId: string,
  proposal: Omit<SubagentProposal, 'at'>,
): void {
  const prev = useSubagentProposalsStore.getState().bySession;
  useSubagentProposalsStore.setState({
    bySession: { ...prev, [sessionId]: { ...proposal, at: Date.now() } },
  });
}

/** Remove a proposal (approved, rejected, or dismissed). */
export function clearSubagentProposal(sessionId: string, proposalId?: string): void {
  const prev = useSubagentProposalsStore.getState().bySession;
  const current = prev[sessionId];
  if (!current) return;
  if (proposalId && current.proposalId !== proposalId) return;
  const next = { ...prev };
  delete next[sessionId];
  useSubagentProposalsStore.setState({ bySession: next });
}
