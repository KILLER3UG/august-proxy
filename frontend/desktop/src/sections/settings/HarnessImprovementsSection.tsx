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
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { getAutoApplyHistory } from '@/api/api-client/skills-versions';
import { Badge } from '@/components/ui/badge';
import { qk } from '@/lib/query-keys';
import { invalidateReviewInboxCount } from '@/lib/useReviewInboxCount';
import { cn, formatTimeAgo } from '@/lib/utils';
import { parseEvidence } from './harnessEvidence';

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
  /** The reviewer's verdict as one sentence, formed by the backend's
   *  `review_summary()`. `''` when no reviewer saw this proposal, which is how
   *  the row is omitted rather than rendered blank. */
  reviewLine?: string;
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
  open: { label: 'Open', className: 'border-warning/30 bg-warning/10 text-warning-fg' },
  applied: { label: 'Applied', className: 'border-success/30 bg-success/10 text-success-fg' },
  apply_failed: { label: 'Apply failed', className: 'border-danger/30 bg-danger/10 text-danger-fg' },
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

/** Item 14's readable history of what August changed by itself.
 *
 * One disclosure inside the inbox rather than a new section: "what happened to
 * my agent while I wasn't looking" is the question this page already answers,
 * and a second page would be a second place to look. Rows name the skill and
 * when, never the proposal id — the id is a key, not a label.
 *
 * Renders nothing when the list is empty. "August has changed nothing by
 * itself" is not information; the switch state in the header already says it.
 */
function AutoChangeHistory() {
  const historyQ = useQuery({
    queryKey: ['harness-auto-history'],
    queryFn: () => getAutoApplyHistory(50),
    staleTime: 60_000,
  });
  const changes = historyQ.data?.changes ?? [];
  const shadow = historyQ.data?.shadow ?? [];
  // Nothing to report either way — no decorative empty block.
  if (!changes.length && !shadow.length) return null;
  const autonomy = historyQ.data?.autonomy ?? false;

  return (
    <details
      data-testid="auto-change-history"
      className="shrink-0 rounded-xl border border-border/50 bg-card/40 px-3 py-2"
    >
      <summary className="cursor-pointer text-2xs text-muted-foreground">
        {changes.length > 0 && (
          <>
            {changes.length} change{changes.length === 1 ? '' : 's'} applied by itself ·{' '}
          </>
        )}
        {shadow.length > 0 && (
          <>
            {shadow.length} shadow decision{shadow.length === 1 ? '' : 's'} ·{' '}
          </>
        )}
        {autonomy ? 'autonomy is on' : 'autonomy is off'}
      </summary>
      {changes.length > 0 && (
        <ul className="mt-2 space-y-1">
          {changes.map((c) => (
            <li
              key={c.proposalId}
              data-testid="auto-change-row"
              className="flex flex-wrap items-baseline gap-x-2 text-2xs"
            >
              <span className="text-foreground">{c.skill || 'a skill'}</span>
              <span className="text-muted-foreground/70">{formatTimeAgo(c.at)}</span>
              {/* Probation put this one back. Said plainly, because a change that
                  no longer exists still deserves its line in the record. */}
              {c.reverted && <span className="text-muted-foreground">restored</span>}
            </li>
          ))}
        </ul>
      )}
      {shadow.length > 0 && (
        <>
          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground/70">
            Shadow mode — what the rails decided they would have done. Nothing
            here was written to a skill.
          </p>
          <ul className="mt-1 space-y-1">
            {shadow.map((d) => (
              <li
                key={d.proposalId}
                data-testid="shadow-decision-row"
                className="flex flex-wrap items-baseline gap-x-2 text-2xs"
              >
                <span className="text-foreground">{d.skill || d.kind}</span>
                <span className="text-muted-foreground/70">{formatTimeAgo(d.at)}</span>
                {d.wouldApply ? (
                  <span className="text-muted-foreground">would have applied</span>
                ) : (
                  /* The rail's own name rather than a paraphrase: which rail
                     held it is the entire reason to read this list. */
                  <span className="text-muted-foreground">held by {d.heldBy}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
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
    queryKey: qk.harnessProposals(filter),
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
    void queryClient.invalidateQueries({ queryKey: qk.harnessProposals() });
    void queryClient.invalidateQueries({ queryKey: ['memory-proposals'] });
    invalidateReviewInboxCount(queryClient);
  }, [queryClient]);

  const rows = useMemo<Proposal[]>(() => {
    const harness = (harnessQ.data?.proposals ?? []).map(
      (p): Proposal => ({ ...p, queue: 'harness' }),
    );
    let memory: Proposal[] = [];
    try {
      memory = (memoryQ.data?.proposals ?? []).map(memoryToProposal);
    } catch {
      memory = []; // a malformed memory row must not blank the harness queue
    }
    return [...harness, ...memory].sort((a, b) => {
      // A measured regression is the one row here that carries its own
      // evidence of harm, so it outranks recency — everything else is still
      // newest-first.
      if (a.kind === 'revert') return b.kind === 'revert' ? (a.createdAt < b.createdAt ? 1 : -1) : -1;
      if (b.kind === 'revert') return 1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }, [harnessQ.data, memoryQ.data]);

  const selected = rows.find((r) => rowKey(r) === selectedId) ?? null;
  /* A skill proposal IS a document. `payload` used to be dumped as escaped
   * JSON in a 10rem box, so the one person who can say no to a learned skill
   * was approving a body they could not read. */
  const draftedBody = typeof selected?.payload?.body === 'string' ? selected.payload.body : '';
  const draftedLabel = selected?.kind === 'skill_patch' ? 'Body this patch writes' : 'Drafted skill';
  // Same key the disclosure and the chat chip use, so this is one request, not
  // three — react-query dedupes by key.
  const autoQ = useQuery({
    queryKey: ['harness-auto-history'],
    queryFn: () => getAutoApplyHistory(1),
    staleTime: 60_000,
  });
  const autonomyOn = Boolean(autoQ.data?.autonomy);
  const selectedReviewerLine = selected?.reviewLine ?? '';
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
          onClick: () => {
            // void-ignored: a toast action wants a synchronous callback, and
            // nothing upstream can await this promise.
            void (async () => {
              for (const row of targets) {
                if (row.queue === 'memory') continue; // memory has no reopen
                try {
                  await postDecide(row, 'reopen');
                } catch {
                  /* one undo failure must not swallow the rest */
                }
              }
              refresh();
            })();
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
          <p data-testid="inbox-header-note" className="mt-1 max-w-xl text-sm text-muted-foreground">
            Everything August wants a human to decide: harness improvement proposals
            (self-improvement, distiller drafts, cross-project promotions) and memory
            retirements.{' '}
            {/* The page's own promise has to track the switch. Saying "nothing
                applies until you approve it" while autonomous apply is on
                misdescribes when this machinery writes to your skills. */}
            {autonomyOn
              ? 'Autonomous apply is on: the rails apply qualifying skill changes on their own, and every one of them is listed below and undoable.'
              : 'Nothing applies until you approve it — approvable kinds run a deterministic applier, the rest are recorded for manual implementation.'}
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
            <RefreshCw className={cn('size-3', fetching && 'animate-spin')} />
          </button>
        </div>
      </header>

      <AutoChangeHistory />

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
            <CircleX className="size-3" /> Reject selected
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
                  <span className="font-mono text-2xs text-muted-foreground">{selected.id}</span>
                  <Badge variant="outline" className="text-2xs uppercase">{selected.kind}</Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      'flex items-center gap-1 text-2xs',
                      selected.queue === 'memory' ? 'text-violet-400 border-violet-500/30' : 'text-muted-foreground',
                    )}
                  >
                    {selected.queue === 'memory' ? <Database className="size-3" /> : <HeartPulse className="size-3" />}
                    {selected.queue}
                  </Badge>
                  <Badge className={cn('border text-2xs', STATUS_META[selected.status].className)}>
                    {STATUS_META[selected.status].label}
                  </Badge>
                  {selected.queue === 'harness' && !APPROVABLE.has(selected.kind) && selected.status === 'open' && (
                    <Badge
                      data-testid="measured-regression-tag"
                      className={cn(
                        'border text-2xs',
                        selected.kind === 'revert'
                          ? 'border-danger/30 bg-danger/10 text-danger-fg'
                          : 'border-sky-500/30 bg-sky-500/10 text-sky-400',
                      )}
                    >
                      {selected.kind === 'revert'
                        ? 'measured regression — the rollback below is yours to run'
                        : 'human-only — records findings'}
                    </Badge>
                  )}
                </div>
                {selectedReviewerLine && (
                  <p data-testid="reviewer-line" className="mt-1.5 text-xs text-muted-foreground">
                    {selectedReviewerLine}
                  </p>
                )}
                <p className="mt-2 text-[0.8125rem] leading-relaxed text-foreground">{selected.problem}</p>
              </div>
              {selected.decidedAt && (
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {formatTimeAgo(selected.decidedAt)}
                </span>
              )}
            </div>

            <EvidenceRow label="Evidence" body={selected.evidence} />
            <InfoRow label="Proposed change" body={selected.proposal} mono={false} />
            {draftedBody && (
              <div>
                <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {draftedLabel}
                </p>
                <div
                  className="mt-1 max-h-96 overflow-y-auto rounded-lg border border-border/40 bg-muted/20 px-3 py-2"
                  data-testid="proposal-drafted-body"
                >
                  <Markdown content={draftedBody} />
                </div>
              </div>
            )}
            <InfoRow label="Rollback" body={selected.rollback} mono={false} />
            {selected.expectedMetric && (
              <InfoRow label="Expected metric" body={selected.expectedMetric} mono={false} />
            )}
            {selected.payload && Object.keys(selected.payload).length > 0 && (
              <InfoRow
                label="Payload"
                body={JSON.stringify(
                  draftedBody
                    ? { ...selected.payload, body: `${draftedBody.length} chars — rendered above` }
                    : selected.payload,
                  null,
                  2,
                )}
                mono
              />
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
                          : selected.kind === 'revert'
                            ? 'A measured regression is undone by hand — run the rollback, then reject or dismiss'
                            : 'This kind is recorded only — approval does not apply anything'
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
                    data-testid="proposal-approve"
                  >
                    {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                    {selected.queue === 'memory' ? 'Approve (retire)' : 'Approve & apply'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(selected, 'reject')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
                    data-testid="proposal-reject"
                  >
                    <CircleX className="size-3" /> {selected.queue === 'memory' ? 'Keep' : 'Reject'}
                  </button>
                  {selected.queue === 'harness' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(selected, 'dismiss')}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
                      data-testid="proposal-dismiss"
                    >
                      <X className="size-3" /> Dismiss
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
                  <Undo2 className="size-3" /> Reopen
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
              <CircleCheck className="mb-3 size-8 text-success-fg" />
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
            <label className="flex items-center gap-2 px-1 text-2xs text-muted-foreground">
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
                    <CircleCheck className="size-4 text-success-fg" />
                  ) : p.status === 'apply_failed' ? (
                    <CircleX className="size-4 text-danger-fg" />
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
                    <Badge className={cn('border text-2xs uppercase', STATUS_META[p.status].className)}>
                      {STATUS_META[p.status].label}
                    </Badge>
                    <Badge variant="outline" className="text-2xs uppercase">{p.kind}</Badge>
                    {p.kind === 'revert' && (
                      <Badge
                        data-testid="measured-regression-tag"
                        className="border border-danger/30 bg-danger/10 text-2xs text-danger-fg"
                      >
                        measured regression
                      </Badge>
                    )}
                    <span
                      className={cn(
                        'text-2xs uppercase tracking-wide',
                        p.queue === 'memory' ? 'text-violet-400/80' : 'text-muted-foreground/70',
                      )}
                    >
                      {p.queue === 'memory' ? <Database className="mr-0.5 inline size-2.5" /> : null}
                      {p.queue}
                    </span>
                    <span className="text-2xs text-muted-foreground">
                      {p.createdAt ? formatTimeAgo(p.createdAt) : ''}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-1 text-[0.8125rem] font-medium text-foreground">{p.problem}</p>
                  <p className="mt-0.5 line-clamp-1 text-2xs text-muted-foreground">{p.evidence}</p>
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
      <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <pre
        className={cn(
          'mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-[0.75rem] leading-relaxed text-foreground/90',
          mono ? 'font-mono' : 'font-sans',
        )}
      >
        {body}
      </pre>
    </div>
  );
}

/* ── Evidence chips ─────────────────────────────────────────────────────── */
/* ── Evidence chips ─────────────────────────────────────────────────────── */
/* The parser itself lives in ./harnessEvidence.ts: a component module may not
 * export plain functions without costing fast refresh. */


function EvidenceRow({ label, body }: { label: string; body: string }) {
  if (!body?.trim()) return null;
  const { sections, structured } = parseEvidence(body);
  return (
    <div>
      <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      {structured ? (
        <div data-testid="evidence-chips" className="mt-1 max-h-52 space-y-2 overflow-y-auto">
          {sections.map((sec, i) => (
            <div key={i} data-testid="evidence-section">
              {sec.title ? (
                <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/80">
                  {sec.title}
                </p>
              ) : null}
              <div className="mt-1 flex flex-wrap gap-1.5">
                {sec.items.map((item, j) => (
                  <span
                    key={j}
                    data-testid="evidence-chip"
                    title={item}
                    className="max-w-full truncate rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-2xs text-foreground/90"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-[0.75rem] leading-relaxed text-foreground/90">
          {body}
        </pre>
      )}
    </div>
  );
}
