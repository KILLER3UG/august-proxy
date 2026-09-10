/* ── Review inbox — every pending human decision, one queue ─────────── */
/* Merges the two review queues the learning loop writes into:           */
/* harness proposals (self-improve / distiller / promotion) and memory  */
/* proposals (OQ5 preference-retire). NOTHING is applied automatically: */
/* a human approves (runs the deterministic applier), rejects, or       */
/* dismisses each row. Batch decisions carry a reopen undo (side-effect */
/* -free decisions only — applied rows would need a real revert).       */
/* Every decision lands in the harness ledger; both stores' pending     */
/* counts feed the settings-rail badge via /inbox/count.                */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  CircleCheck,
  CircleX,
  Clock,
  Database,
  HeartPulse,
  Loader2,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { invalidateReviewInboxCount } from '@/lib/useReviewInboxCount';
import { cn, formatTimeAgo } from '@/lib/utils';

type Queue = 'harness' | 'memory';

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
  queue: Queue;
}

interface ProposalsResponse {
  proposals: Proposal[];
  openCount: number;
}

interface MemoryProposalRow {
  id: number;
  proposalType: string;
  status: string;
  createdAt?: string;
  decidedAt?: string;
  content?: { key?: string; title?: string; reason?: string; lastTouch?: string };
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

/** Map one memory-store retire-preference row into the shared card shape
 *  so both queues render with one component. The memory queue has no
 *  'dismissed' state (approve/reject only) — rejected covers both. */
function memoryToProposal(r: MemoryProposalRow): Proposal {
  const content = r.content ?? {};
  const title = content.title || content.key || `memory proposal ${r.id}`;
  return {
    id: `mem:${r.id}`,
    createdAt: r.createdAt ?? '',
    kind: r.proposalType,
    status: r.status === 'pending' ? 'open' : r.status === 'approved' ? 'applied' : 'rejected',
    problem: `Retire stale preference “${title}”?`,
    evidence: content.reason ?? '',
    proposal:
      'Approve retires the fact (row survives, reversible from the memory UI); reject keeps it.',
    rollback: 'memory UI: un-retire the fact',
    decidedAt: r.decidedAt,
    queue: 'memory',
  };
}

function rowKey(p: Proposal): string {
  return `${p.queue}:${p.id}`;
}

export function HarnessImprovementsSection() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const harnessQ = useQuery({
    queryKey: ['harness-proposals', filter],
    queryFn: () =>
      api.get<ProposalsResponse>(
        `/api/harness/proposals${filter === 'open' ? '?status=open' : ''}`,
      ),
    refetchInterval: 30_000,
  });
  const memoryQ = useQuery({
    queryKey: ['memory-proposals'],
    queryFn: () =>
      api.get<{ ok: boolean; proposals: MemoryProposalRow[] }>(
        // Served by the august router (prefix /api/august) — not /api/memory.
        `/api/august/memory/proposals${filter === 'open' ? '?status=pending' : ''}`,
      ),
    refetchInterval: 30_000,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['harness-proposals'] });
    void queryClient.invalidateQueries({ queryKey: ['memory-proposals'] });
    invalidateReviewInboxCount(queryClient);
  }, [queryClient]);

  const rows = useMemo<Proposal[]>(() => {
    const harness = (harnessQ.data?.proposals ?? []).map((p) => ({ ...p, queue: 'harness' as Queue }));
    let memory: Proposal[] = [];
    try {
      memory = (memoryQ.data?.proposals ?? []).map(memoryToProposal);
    } catch {
      memory = []; // a malformed memory row must not blank the harness queue
    }
    return [...harness, ...memory].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [harnessQ.data, memoryQ.data]);

  const selected = rows.find((r) => rowKey(r) === selectedId) ?? null;
  const fetching = harnessQ.isFetching || memoryQ.isFetching;

  const postDecide = useCallback(async (row: Proposal, decision: 'approve' | 'reject' | 'dismiss' | 'reopen') => {
    if (row.queue === 'memory') {
      // The memory endpoint takes approve|reject on its numeric id and has
      // no dismiss/reopen vocabulary — send only what it understands. It
      // also reports failure as HTTP 200 + {ok:false} (api.request only
      // throws on non-2xx), so inspect the envelope explicitly.
      const res = await api.post<{ ok?: boolean; error?: string }>(
        `/api/august/memory/proposals/${encodeURIComponent(row.id.slice('mem:'.length))}/decide`,
        { decision: decision === 'approve' ? 'approve' : 'reject' },
      );
      if (!res?.ok) throw new Error(res?.error ?? 'memory decision failed');
      return;
    }
    await api.post(`/api/harness/proposals/${encodeURIComponent(row.id)}/decide`, {
      decision,
      note,
    });
  }, [note]);

  const decide = async (row: Proposal, decision: 'approve' | 'reject' | 'dismiss' | 'reopen') => {
    setBusy(true);
    setError(null);
    try {
      await postDecide(row, decision);
      setNote('');
      setSelectedId(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleCheck = (row: Proposal) => {
    setSelectedId(null);
    setChecked((prev) => {
      const next = new Set(prev);
      const k = rowKey(row);
      if (next.has(k)) next.delete(k);
      else if (row.status === 'open') next.add(k); // only open rows are actionable
      return next;
    });
  };

  const openRows = rows.filter((r) => r.status === 'open');
  const allChecked = openRows.length > 0 && openRows.every((r) => checked.has(rowKey(r)));

  /** Batch-reject the checked rows with one undo that reopens them. Only
   *  'reject' is batch-offered: approve runs appliers (not side-effect
   *  free), and dismiss has no memory-queue equivalent. */
  const batchReject = async () => {
    const targets = openRows.filter((r) => checked.has(rowKey(r)));
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    const failed: Proposal[] = [];
    for (const row of targets) {
      try {
        await postDecide(row, 'reject');
      } catch {
        failed.push(row);
      }
    }
    setChecked(new Set());
    refresh();
    setBusy(false);
    const rejected = targets.length - failed.length;
    if (failed.length) setError(`${failed.length} decision(s) failed; ${rejected} rejected.`);
    if (rejected > 0) {
      toast(rejected > 1 ? `${rejected} proposals rejected` : 'Proposal rejected', {
        action: {
          label: 'Undo',
          onClick: async () => {
            for (const row of targets) {
              if (row.queue === 'memory') continue; // memory has no reopen
              try {
                await postDecide(row, 'reopen');
              } catch {
                /* one undo failure must not swallow the rest */
              }
            }
            refresh();
          },
        },
      });
    }
  };

  return (
    <div className="px-8 py-6 space-y-5 h-full flex flex-col overflow-hidden">
      <header className="shrink-0 flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
            <HeartPulse className="size-6 text-primary" />
            Review Inbox
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Everything August wants a human to decide: harness improvement proposals
            (self-improvement, distiller drafts, cross-project promotions) and memory
            retirements. Nothing applies until you approve it — approvable kinds run a
            deterministic applier, the rest are recorded for manual implementation.
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
                  setChecked(new Set());
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
            onClick={() => {
              void harnessQ.refetch();
              void memoryQ.refetch();
            }}
            className="rounded-lg border border-border/60 p-2 text-muted-foreground transition hover:text-foreground"
            title="Refresh"
            aria-label="Refresh proposals"
          >
            <RefreshCw className={cn('size-3.5', fetching && 'animate-spin')} />
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {checked.size > 0 && (
        <div className="flex shrink-0 items-center gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-xs">
          <span className="text-muted-foreground">{checked.size} selected</span>
          <button
            type="button"
            data-testid="inbox-batch-reject"
            disabled={busy}
            onClick={() => void batchReject()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-2.5 py-1 font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
          >
            <CircleX className="size-3.5" /> Reject selected
          </button>
          <button
            type="button"
            onClick={() => setChecked(new Set())}
            className="ml-auto text-muted-foreground transition hover:text-foreground"
          >
            Clear
          </button>
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
            <ArrowLeft className="size-4" /> Back to inbox
          </button>

          <div className="max-w-3xl space-y-3 rounded-xl border border-border/60 bg-card/60 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground">{selected.id}</span>
                  <Badge variant="outline" className="text-[10px] uppercase">{selected.kind}</Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      'flex items-center gap-1 text-[10px]',
                      selected.queue === 'memory' ? 'text-violet-400 border-violet-500/30' : 'text-muted-foreground',
                    )}
                  >
                    {selected.queue === 'memory' ? <Database className="size-3" /> : <HeartPulse className="size-3" />}
                    {selected.queue}
                  </Badge>
                  <Badge className={cn('border text-[10px]', STATUS_META[selected.status].className)}>
                    {STATUS_META[selected.status].label}
                  </Badge>
                  {selected.queue === 'harness' && !APPROVABLE.has(selected.kind) && selected.status === 'open' && (
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
                    disabled={
                      busy ||
                      (selected.queue === 'harness' && !APPROVABLE.has(selected.kind))
                    }
                    onClick={() => void decide(selected, 'approve')}
                    title={
                      selected.queue === 'memory'
                        ? 'Retire the fact (reversible in the memory UI)'
                        : APPROVABLE.has(selected.kind)
                          ? 'Run the deterministic applier'
                          : 'This kind is recorded only — approval does not apply anything'
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
                    data-testid="proposal-approve"
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                    {selected.queue === 'memory' ? 'Approve (retire)' : 'Approve & apply'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(selected, 'reject')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
                    data-testid="proposal-reject"
                  >
                    <CircleX className="size-3.5" /> {selected.queue === 'memory' ? 'Keep' : 'Reject'}
                  </button>
                  {selected.queue === 'harness' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(selected, 'dismiss')}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
                      data-testid="proposal-dismiss"
                    >
                      <X className="size-3.5" /> Dismiss
                    </button>
                  )}
                </div>
              </div>
            )}
            {selected.queue === 'harness' && (selected.status === 'rejected' || selected.status === 'dismissed') && (
              <div className="border-t border-border/50 pt-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(selected, 'reopen')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-40"
                  data-testid="proposal-reopen"
                >
                  <Undo2 className="size-3.5" /> Reopen
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── Inbox list ─────────────────────────────────────────────── */
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="proposal-queue">
          {(harnessQ.isLoading || memoryQ.isLoading) && (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          {!fetching && !harnessQ.isLoading && rows.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-card/40 px-6 py-12 text-center">
              <CircleCheck className="mb-3 size-8 text-emerald-400/70" />
              <p className="text-sm font-medium text-foreground">
                {filter === 'open' ? 'Nothing waiting for you' : 'No proposals yet'}
              </p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                When the model spots something to improve — via introspection sweeps, the
                distiller, cross-project promotion, or a stale-preference scan — the row
                appears here and a badge counts it in this rail.
              </p>
            </div>
          )}
          {rows.length > 0 && openRows.length > 1 && (
            <label className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="size-3 accent-primary"
                checked={allChecked}
                onChange={() =>
                  setChecked(allChecked ? new Set() : new Set(openRows.map(rowKey)))
                }
              />
              Select all open ({openRows.length})
            </label>
          )}
          {rows.map((p) => (
            <div
              key={rowKey(p)}
              data-testid={`proposal-row-${p.id}`}
              className="group w-full rounded-xl border border-border/50 bg-card/50 p-4 text-left transition hover:border-border hover:bg-card/80"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0">
                  {p.status === 'open' ? (
                    <button
                      type="button"
                      onClick={() => toggleCheck(p)}
                      aria-label={`Select ${p.problem}`}
                      className="flex items-center"
                    >
                      <input
                        type="checkbox"
                        readOnly
                        checked={checked.has(rowKey(p))}
                        className="size-3 accent-primary"
                        tabIndex={-1}
                      />
                    </button>
                  ) : p.status === 'applied' ? (
                    <CircleCheck className="size-4 text-emerald-400" />
                  ) : p.status === 'apply_failed' ? (
                    <CircleX className="size-4 text-rose-400" />
                  ) : (
                    <Clock className="size-4 text-muted-foreground" />
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedId(rowKey(p))}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge className={cn('border text-[9px] uppercase', STATUS_META[p.status].className)}>
                      {STATUS_META[p.status].label}
                    </Badge>
                    <Badge variant="outline" className="text-[9px] uppercase">{p.kind}</Badge>
                    <span
                      className={cn(
                        'text-[9px] uppercase tracking-wide',
                        p.queue === 'memory' ? 'text-violet-400/80' : 'text-muted-foreground/70',
                      )}
                    >
                      {p.queue === 'memory' ? <Database className="mr-0.5 inline size-2.5" /> : null}
                      {p.queue}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {p.createdAt ? formatTimeAgo(p.createdAt) : ''}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-1 text-[13px] font-medium text-foreground">{p.problem}</p>
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{p.evidence}</p>
                </button>
              </div>
            </div>
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
