/* ── Harness Improvements — proposal review queue (0.17.0) ─────────── */
/* The model inspects its own harness and files structured improvement  */
/* proposals. NOTHING is applied automatically: this queue is where a   */
/* human approves (runs the deterministic applier), rejects, or         */
/* dismisses each one. Every decision lands in the harness ledger.      */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  CircleCheck,
  CircleX,
  Clock,
  HeartPulse,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { cn, formatTimeAgo } from '@/lib/utils';

interface Proposal {
  id: string;
  createdAt: string;
  sessionId?: string;
  kind: string;
  status: 'open' | 'applied' | 'apply_failed' | 'rejected' | 'dismissed';
  problem: string;
  evidence: string;
  proposal: string;
  rollback: string;
  expectedMetric?: string;
  payload?: Record<string, unknown>;
  decidedAt?: string;
  decisionNote?: string;
  applyResult?: { ok?: boolean; error?: string; action?: string; name?: string };
}

interface ProposalsResponse {
  proposals: Proposal[];
  openCount: number;
}

type Filter = 'open' | 'all';

const STATUS_META: Record<Proposal['status'], { label: string; className: string }> = {
  open: { label: 'Open', className: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  applied: { label: 'Applied', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  apply_failed: { label: 'Apply failed', className: 'border-rose-500/30 bg-rose-500/10 text-rose-400' },
  rejected: { label: 'Rejected', className: 'border-border bg-muted/40 text-muted-foreground' },
  dismissed: { label: 'Dismissed', className: 'border-border bg-muted/40 text-muted-foreground' },
};

const APPROVABLE = new Set(['brain_config', 'skill_create', 'skill_patch', 'skill_delete']);

export function HarnessImprovementsSection() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['harness-proposals', filter],
    queryFn: () =>
      api.get<ProposalsResponse>(
        `/api/harness/proposals${filter === 'open' ? '?status=open' : ''}`,
      ),
    refetchInterval: 30_000,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['harness-proposals'] });
  }, [queryClient]);

  const rows = useMemo(() => query.data?.proposals ?? [], [query.data]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const decide = async (id: string, decision: 'approve' | 'reject' | 'dismiss') => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/harness/proposals/${encodeURIComponent(id)}/decide`, {
        decision,
        note,
      });
      setNote('');
      setSelectedId(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-8 py-6 space-y-5 h-full flex flex-col overflow-hidden">
      <header className="shrink-0 flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
            <HeartPulse className="size-6 text-primary" />
            Harness Improvements
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            The model inspects its own harness and files improvement proposals here. Nothing
            applies until you approve it — approvable kinds run a deterministic applier,
            everything else is recorded for manual implementation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border/60 p-0.5" role="tablist">
            {(['open', 'all'] as Filter[]).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => {
                  setFilter(f);
                  setSelectedId(null);
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition',
                  filter === f
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="rounded-lg border border-border/60 p-2 text-muted-foreground transition hover:text-foreground"
            title="Refresh"
            aria-label="Refresh proposals"
          >
            <RefreshCw className={cn('size-3.5', query.isFetching && 'animate-spin')} />
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* ── Detail view ─────────────────────────────────────────────── */}
      {selected ? (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back to queue
          </button>

          <div className="max-w-3xl space-y-3 rounded-xl border border-border/60 bg-card/60 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground">{selected.id}</span>
                  <Badge variant="outline" className="text-[10px] uppercase">{selected.kind}</Badge>
                  <Badge className={cn('border text-[10px]', STATUS_META[selected.status].className)}>
                    {STATUS_META[selected.status].label}
                  </Badge>
                  {!APPROVABLE.has(selected.kind) && selected.status === 'open' && (
                    <Badge className="border border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-400">
                      human-only — records findings
                    </Badge>
                  )}
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-foreground">{selected.problem}</p>
              </div>
              {selected.decidedAt && (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatTimeAgo(selected.decidedAt)}
                </span>
              )}
            </div>

            <InfoRow label="Evidence" body={selected.evidence} mono={false} />
            <InfoRow label="Proposed change" body={selected.proposal} mono={false} />
            <InfoRow label="Rollback" body={selected.rollback} mono={false} />
            {selected.expectedMetric && (
              <InfoRow label="Expected metric" body={selected.expectedMetric} mono={false} />
            )}
            {selected.payload && Object.keys(selected.payload).length > 0 && (
              <InfoRow label="Payload" body={JSON.stringify(selected.payload, null, 2)} mono />
            )}
            {selected.applyResult?.error && (
              <InfoRow label="Apply error" body={selected.applyResult.error} mono={false} />
            )}
            {selected.decisionNote && (
              <InfoRow label="Decision note" body={selected.decisionNote} mono={false} />
            )}

            {selected.status === 'open' && (
              <div className="space-y-2 border-t border-border/50 pt-3">
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional decision note…"
                  className="w-full rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || !APPROVABLE.has(selected.kind)}
                    onClick={() => void decide(selected.id, 'approve')}
                    title={
                      APPROVABLE.has(selected.kind)
                        ? 'Run the deterministic applier'
                        : 'This kind is recorded only — approval does not apply anything'
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
                    data-testid="proposal-approve"
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                    Approve & apply
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(selected.id, 'reject')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
                    data-testid="proposal-reject"
                  >
                    <CircleX className="size-3.5" /> Reject
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(selected.id, 'dismiss')}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
                    data-testid="proposal-dismiss"
                  >
                    <X className="size-3.5" /> Dismiss
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── Queue list ───────────────────────────────────────────── */
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="proposal-queue">
          {query.isLoading && (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          {!query.isLoading && rows.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-card/40 px-6 py-12 text-center">
              <CircleCheck className="mb-3 size-8 text-emerald-400/70" />
              <p className="text-sm font-medium text-foreground">
                {filter === 'open' ? 'No open proposals' : 'No proposals yet'}
              </p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                When the model spots something to improve in its own harness — via the
                harness_introspect / harness_propose tools or the scheduled introspection sweep —
                it files a proposal here for your review.
              </p>
            </div>
          )}
          {rows.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              data-testid={`proposal-row-${p.id}`}
              className="group w-full rounded-xl border border-border/50 bg-card/50 p-4 text-left transition hover:border-border hover:bg-card/80"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0">
                  {p.status === 'applied' ? (
                    <CircleCheck className="size-4 text-emerald-400" />
                  ) : p.status === 'open' ? (
                    <Clock className="size-4 text-amber-400" />
                  ) : (
                    <CircleX className="size-4 text-muted-foreground" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge className={cn('border text-[9px] uppercase', STATUS_META[p.status].className)}>
                      {STATUS_META[p.status].label}
                    </Badge>
                    <Badge variant="outline" className="text-[9px] uppercase">{p.kind}</Badge>
                    <span className="text-[10px] text-muted-foreground">{formatTimeAgo(p.createdAt)}</span>
                  </div>
                  <p className="mt-1 line-clamp-1 text-[13px] font-medium text-foreground">{p.problem}</p>
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{p.evidence}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, body, mono }: { label: string; body: string; mono: boolean }) {
  if (!body?.trim()) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <pre
        className={cn(
          'mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-[12px] leading-relaxed text-foreground/90',
          mono ? 'font-mono' : 'font-sans',
        )}
      >
        {body}
      </pre>
    </div>
  );
}
