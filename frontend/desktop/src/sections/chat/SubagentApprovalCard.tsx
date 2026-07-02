/* ── SubagentApprovalCard ────────────────────────────────────────────── */
/* Approval card for proposed-mode sub-agent breakdown. Shows work items
   and allows Approve/Cancel. */

import { useState } from 'react';
import { Loader2, Check, X } from 'lucide-react';
import { proposeBreakdown } from '@/api/subagents';

interface WorkBreakdownItem {
  goal: string;
  agent_id?: string;
}

interface SubagentApprovalCardProps {
  proposalId: string;
  workBreakdown: WorkBreakdownItem[];
  onApproved: () => void;
  onRejected: () => void;
}

export function SubagentApprovalCard({
  proposalId,
  workBreakdown,
  onApproved,
  onRejected,
}: SubagentApprovalCardProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    setLoading(true);
    setError(null);
    try {
      await proposeBreakdown(proposalId, true);
      onApproved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Approval failed');
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    setLoading(true);
    setError(null);
    try {
      await proposeBreakdown(proposalId, false);
      onRejected();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Rejection failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="size-2 rounded-full bg-primary animate-pulse" />
        <p className="text-sm font-semibold">Sub-agent plan proposed</p>
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
          Work breakdown
        </p>
        {workBreakdown.map((item, i) => (
          <div
            key={i}
            className="rounded-lg border border-white/[0.06] bg-card/40 px-3 py-2 text-xs"
          >
            <p className="font-medium text-foreground/90">{item.goal}</p>
            {item.agent_id && (
              <p className="text-[10px] text-muted-foreground font-mono">
                Agent: {item.agent_id}
              </p>
            )}
          </div>
        ))}
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleApprove}
          disabled={loading}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" />
          )}
          Approve
        </button>
        <button
          type="button"
          onClick={handleReject}
          disabled={loading}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.06] px-3 py-2 text-xs font-medium hover:bg-white/[0.06] disabled:opacity-50"
        >
          <X className="size-3" />
          Cancel
        </button>
      </div>
    </div>
  );
}
