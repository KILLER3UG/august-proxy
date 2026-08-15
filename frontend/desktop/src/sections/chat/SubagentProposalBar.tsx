/* ── SubagentProposalBar — inline approval for spawn_subagents(mode='proposed') ── */
/* The model asked for a work breakdown before spawning. Launch/Reject posts
 * to POST /api/subagents/propose-breakdown; the Runs tab mirrors the same
 * pending proposals. */

import { useSyncExternalStore } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Play, X } from 'lucide-react';
import * as subagents from '@/api/subagents';
import {
  $subagentProposals,
  clearSubagentProposal,
} from './subagent-proposals-store';

export function SubagentProposalBar({ sessionId }: { sessionId: string | null }) {
  const bySession = useSyncExternalStore($subagentProposals.subscribe, $subagentProposals.get);
  const qc = useQueryClient();
  const proposal = sessionId ? bySession[sessionId] : undefined;

  const decide = useMutation({
    mutationFn: ({ proposalId, approved }: { proposalId: string; approved: boolean }) =>
      subagents.proposeBreakdown(proposalId, approved),
    onSuccess: (_res, vars) => {
      toast.success(
        vars.approved ? 'Sub-agents launched — watch the roster in the right drawer' : 'Proposal rejected',
      );
      if (sessionId) clearSubagentProposal(sessionId);
      void qc.invalidateQueries({ queryKey: ['subagent-runs'] });
      void qc.invalidateQueries({ queryKey: ['subagent-proposals'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Decision failed'),
  });

  if (!proposal) return null;
  const count = Array.isArray(proposal.workBreakdown) ? proposal.workBreakdown.length : 0;

  return (
    <div
      className="w-full rounded-xl border border-primary/40 bg-primary/[0.06] px-3 py-2.5 text-xs space-y-2"
      data-testid="subagent-proposal-bar"
    >
      <div className="flex items-center gap-2">
        <Play className="size-3.5 text-primary" />
        <p className="font-medium text-foreground">
          Agent breakdown proposed — {count} sub-agent{count === 1 ? '' : 's'} ready to launch
        </p>
        <button
          type="button"
          aria-label="Dismiss proposal"
          className="ml-auto p-1 rounded text-muted-foreground hover:text-foreground"
          onClick={() => sessionId && clearSubagentProposal(sessionId)}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {(proposal.workBreakdown ?? []).slice(0, 4).map((item, i) => (
        <p key={i} className="pl-4 text-muted-foreground/90">
          • {item.goal || '(no goal)'}
          {item.agentId ? <span className="text-muted-foreground/60"> — {item.agentId}</span> : null}
        </p>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={decide.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground disabled:opacity-50"
          data-testid="proposal-launch"
          onClick={() => decide.mutate({ proposalId: proposal.proposalId, approved: true })}
        >
          <Check className="size-3" />
          Launch {count} agent{count === 1 ? '' : 's'}
        </button>
        <button
          type="button"
          disabled={decide.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-2.5 py-1.5 text-[11px] text-muted-foreground disabled:opacity-50"
          data-testid="proposal-reject"
          onClick={() => decide.mutate({ proposalId: proposal.proposalId, approved: false })}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
