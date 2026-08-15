/* Keep / Discard per sleep-cycle distill action — never silent-apply. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';

interface DistillAction {
  id: string;
  kind?: string;
  label?: string;
}

interface PendingDistill {
  plan?: Record<string, unknown> | null;
  merged?: number;
  promoted?: number;
  deleted?: number;
  actions?: DistillAction[];
}

export function DistillPendingBar() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['pending-consolidation'],
    queryFn: () => api.get<PendingDistill>('/api/brain/pending-consolidation'),
    refetchInterval: 45_000,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['pending-consolidation'] });
    void qc.invalidateQueries({ queryKey: ['pinned-memories'] });
  };
  const applyOne = useMutation({
    mutationFn: (id: string) =>
      api.post('/api/brain/pending-consolidation/apply-one', { id }),
    onSuccess: () => {
      toast.success('Kept');
      invalidate();
    },
    onError: () => toast.error('Could not keep this distill'),
  });
  const discardOne = useMutation({
    mutationFn: (id: string) =>
      api.post('/api/brain/pending-consolidation/discard-one', { id }),
    onSuccess: () => {
      toast.message('Discarded');
      void qc.invalidateQueries({ queryKey: ['pending-consolidation'] });
    },
    onError: () => toast.error('Could not discard'),
  });
  const discardAll = useMutation({
    mutationFn: () => api.post('/api/brain/pending-consolidation/discard', {}),
    onSuccess: () => {
      toast.message('Distill discarded');
      void qc.invalidateQueries({ queryKey: ['pending-consolidation'] });
    },
  });

  const plan = query.data?.plan;
  const actions = query.data?.actions ?? [];
  if (!plan) return null;

  return (
    <div className="space-y-1" data-testid="distill-pending-bar">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
          <Sparkles className="size-3 text-primary" />
          Distill
        </span>
        <button
          type="button"
          className="ml-auto p-0.5 text-muted-foreground hover:text-foreground"
          aria-label="Discard entire distill"
          onClick={() => discardAll.mutate()}
        >
          <X className="size-3" />
        </button>
      </div>
      {actions.length === 0 ? (
        <span className="text-[11px] text-muted-foreground">Proposed cleanup</span>
      ) : (
        <ul className="space-y-1">
          {actions.map((action) => (
            <li
              key={action.id}
              className="flex items-start gap-1.5 rounded-lg border border-border/40 bg-background/40 px-2 py-1"
            >
              <span className="min-w-0 flex-1 text-[11px] text-foreground/85">
                {action.label || action.id}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] hover:bg-primary/15"
                onClick={() => applyOne.mutate(action.id)}
                disabled={applyOne.isPending || discardOne.isPending}
              >
                Keep
              </button>
              <button
                type="button"
                className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={`Discard ${action.label || action.id}`}
                onClick={() => discardOne.mutate(action.id)}
                disabled={applyOne.isPending || discardOne.isPending}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
