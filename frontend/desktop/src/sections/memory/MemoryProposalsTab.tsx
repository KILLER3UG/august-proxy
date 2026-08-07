/* ── Memory Proposals tab — pending/decided proposals with approve/reject ── */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Check, X, Inbox } from 'lucide-react';
import { toast } from 'sonner';

export interface ProposalRow {
  id: number;
  sessionId?: string;
  proposalType?: string;
  content?: unknown;
  status?: string;
  createdAt?: string;
}

export function MemoryProposalsTab() {
  const qc = useQueryClient();
  const proposalsQ = useQuery<{ results: ProposalRow[] }>({
    queryKey: ['memory-proposals'],
    queryFn: () => api.get<{ results: ProposalRow[] }>('/api/memory/proposals'),
    refetchInterval: 30_000,
  });

  const decide = (id: number, status: 'approved' | 'rejected') => {
    void api
      .post<{ status: string }>(`/api/memory/proposals/${id}/decide`, {
        status,
        decidedBy: 'user',
      })
      .then(() => {
        void qc.invalidateQueries({ queryKey: ['memory-proposals'] });
        toast.success(status === 'approved' ? 'Proposal approved' : 'Proposal rejected');
      })
      .catch(() => toast.error('Could not update proposal'));
  };

  const proposals = proposalsQ.data?.results ?? [];
  const pending = proposals.filter((p) => (p.status ?? 'pending') === 'pending');

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Plan / mutation proposals recorded by the Brain. Approve to apply, reject to discard.
      </p>
      {proposals.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
          <Inbox className="size-5 opacity-50" />
          No proposals yet — the Brain records them as it plans mutations.
        </div>
      )}
      {pending.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
            Pending ({pending.length})
          </p>
          {pending.map((p) => (
            <div
              key={p.id}
              className="rounded-xl border border-border bg-card/60 px-3 py-2.5 space-y-1.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">
                    #{p.id} · {p.proposalType ?? 'proposal'}
                    {p.sessionId ? ` · ${p.sessionId}` : ''}
                  </p>
                  <pre className="mt-1 text-xs text-foreground/90 whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono">
                    {typeof p.content === 'string'
                      ? p.content
                      : JSON.stringify(p.content ?? {}, null, 2)}
                  </pre>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => decide(p.id, 'approved')}
                    title="Approve proposal"
                    className="grid size-6 place-items-center rounded bg-success/10 text-success hover:bg-success/20 transition"
                  >
                    <Check className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(p.id, 'rejected')}
                    title="Reject proposal"
                    className="grid size-6 place-items-center rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {proposals.filter((p) => p.status !== 'pending').length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold pt-2">
            Decided
          </p>
          {proposals
            .filter((p) => p.status !== 'pending')
            .slice(0, 20)
            .map((p) => (
              <div key={p.id} className="rounded-xl border border-border/60 px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  #{p.id} · {p.proposalType ?? 'proposal'} ·{' '}
                </span>
                <span
                  className={
                    p.status === 'approved' ? 'text-success' : 'text-destructive'
                  }
                >
                  {p.status}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
