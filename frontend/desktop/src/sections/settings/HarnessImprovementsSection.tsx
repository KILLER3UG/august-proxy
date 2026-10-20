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
  Loader2,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { getAutoApplyHistory } from '@/api/api-client/skills-versions';
import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/SectionHeader';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { settingsTabPanelId, settingsTabTriggerId } from '@/components/settings/settingsTabIds';
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
  applyResult?: { ok?: boolean; error?: string; action?: string; name?: string; trashId?: string };
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
  content?: {
    key?: string;
    title?: string;
    /** The fact's kind, which the backend now names in every retirement
     *  payload — the card says "retire stale profile memory" rather than
     *  always "memory" because of it. */
    kind?: string;
    reason?: string;
    lastTouch?: string;
  };
}

type Filter = 'open' | 'all';

/* The state of a proposal, said ONCE and in one place. The list row shows it
 * as a DOT beside its name — the reference's list rows carry a status dot,
 * not a filled pill — and the detail view shows the same word. The old code
 * had a badge STACK per row (status + kind + queue + a regression tag), four
 * chips of chrome over a one-line summary; the facts are metadata now, in one
 * muted line at the right of the row. */
const STATUS_META: Record<Proposal['status'], { label: string; dot: string }> = {
  open: { label: 'Open', dot: 'bg-warning' },
  applied: { label: 'Applied', dot: 'bg-success' },
  apply_failed: { label: 'Apply failed', dot: 'bg-danger' },
  rejected: { label: 'Rejected', dot: 'bg-muted-foreground/40' },
  dismissed: { label: 'Dismissed', dot: 'bg-muted-foreground/40' },
};

/** The tablist's own id prefix, so the filter tabs can name the region they
 * drive (`aria-controls`) and the region can name them back. */
const FILTER_TABS = 'inbox-filter';

/** The kinds the backend can APPLY on approval — the same list the
 *  `_APPROVERS` registry carries. `archive` is the second half of the skill
 *  lifecycle: approving it moves the skill into the delete trash, and the
 *  result row below renders the trash id with a Restore button beside it.
 *  `retire` and `promote` are here because they are approvable kinds too —
 *  they were missing, which left a landed proposal kind with a disabled
 *  Approve button and a "human-only" badge that described the opposite of
 *  the truth. */
const APPROVABLE = new Set([
  'brain_config',
  'skill_create',
  'skill_patch',
  'skill_delete',
  'retire',
  'archive',
  'promote',
]);

/** Map one memory-store retirement row into the shared card shape
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
    problem: `Retire stale ${content.kind || 'memory'} “${title}”?`,
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
  const [restoring, setRestoring] = useState(false);

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
      const res = await api.post<{
        ok?: boolean;
        error?: string;
        userMessage?: string;
        pending?: boolean;
        decision?: string;
      }>(
        `/api/august/memory/proposals/${encodeURIComponent(row.id.slice('mem:'.length))}/decide`,
        { decision: decision === 'approve' ? 'approve' : 'reject' },
      );
      // `userMessage` first, and deliberately not `error`: the failure the
      // backend can report is a decision whose writes were queued for undo, and
      // its operator string carries the python function name and the SQLite
      // condition. That belongs in a log; this panel shows a sentence the user
      // can act on, which is also the true one — nothing was applied, the
      // proposal is still pending, so trying again is safe.
      if (!res?.ok) throw new Error(res?.userMessage ?? res?.error ?? 'memory decision failed');
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

  /** Undo an approved archive through the SAME route a delete uses. The
   *  decision stays recorded — this moves the bytes back, it does not rewrite
   *  history — and the inbox count is refreshed because the row is unchanged
   *  but the skill is alive again. */
  const restoreArchived = async (row: Proposal) => {
    const trashId = String(row.applyResult?.trashId ?? '');
    if (!trashId) return;
    setRestoring(true);
    setError(null);
    try {
      const res = await api.post<{ restored?: string }>(
        `/api/skills/restore/${encodeURIComponent(trashId)}`,
      );
      toast.success(`Restored ${res?.restored ?? 'the skill'} — still retired; un-retire it in Settings → Skills`);
      void queryClient.invalidateQueries({ queryKey: ['skills-list'] });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed');
    } finally {
      setRestoring(false);
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
      {/* The panel-section header — NO icon, because the nav in front of it
          already carries the icon and the name (the settings rail and the
          hub's own rail are the same instrument). See the header grammar in
          sections/learning/LearningHub.tsx.
          ONE header for BOTH hosts: this section renders in the settings
          panel and in the Learning hub's Inbox tab, and the same page must
          not look like two different pages depending on how you got here. */}
      <SectionHeader
        title="Review Inbox"
        className="mb-0 shrink-0"
        subtitle={
          <span data-testid="inbox-header-note">
            Everything August wants a human to decide: harness improvement proposals
            (self-improvement, distiller drafts, cross-project promotions) and memory
            retirements.{' '}
            {/* The page's own promise has to track the switch. Saying "nothing
                applies until you approve it" while autonomous apply is on
                misdescribes when this machinery writes to your skills. */}
            {autonomyOn
              ? 'Autonomous apply is on: the rails apply qualifying skill changes on their own, and every one of them is listed below and undoable.'
              : 'Nothing applies until you approve it — approvable kinds run a deterministic applier, the rest are recorded for manual implementation.'}
          </span>
        }
        actions={
          <>
            {/* The filter is a TABLIST, so it is ONE: roving tabindex,
                Arrow/Home/End with automatic activation, and `aria-controls`
                naming the region it drives. The old markup declared
                `role="tablist"` and `role="tab"` with no `aria-controls` and
                no roving tabIndex — two "tabs" with nothing behind them, and
                no way to reach the second one from the keyboard. */}
            <SettingsTabs
              value={filter}
              onChange={(k) => {
                setFilter(k as Filter);
                setSelectedId(null);
                setChecked(new Set());
              }}
              items={[
                { key: 'open', label: 'Open', count: openRows.length },
                { key: 'all', label: 'All', count: rows.length },
              ]}
              label="Proposal filter"
              panelIdPrefix={FILTER_TABS}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                void harnessQ.refetch();
                void memoryQ.refetch();
              }}
              title="Refresh"
              aria-label="Refresh proposals"
              data-testid="inbox-refresh"
            >
              <RefreshCw className={cn('size-3', fetching && 'animate-spin')} />
            </Button>
          </>
        }
      />

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

      {/* ── The region the filter tabs drive ──────────────────────────── */}
      <div
        role="tabpanel"
        id={settingsTabPanelId(FILTER_TABS, filter) ?? undefined}
        aria-labelledby={settingsTabTriggerId(FILTER_TABS, filter)}
        className="min-h-0 flex-1 overflow-y-auto pr-1"
        data-testid="inbox-panel"
      >
      {/* ── Detail view ─────────────────────────────────────────────── */}
      {selected ? (
        <div className="space-y-4">
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
                {/* One muted metadata line instead of a STACK of badges
                    (kind + queue + status + a regression tag). The facts do
                    not disappear — they stop being four chips of chrome over
                    a sentence. */}
                <p className="text-2xs uppercase tracking-wide text-muted-foreground/70">
                  {selected.kind}
                  <span className="mx-1.5 normal-case tracking-normal text-muted-foreground/50">·</span>
                  {selected.queue === 'memory' ? 'memory' : 'harness'}
                  {selected.queue === 'harness' && !APPROVABLE.has(selected.kind) && selected.status === 'open' ? (
                    <>
                      <span className="mx-1.5 normal-case tracking-normal text-muted-foreground/50">·</span>
                      <span data-testid="measured-regression-tag">
                        {selected.kind === 'revert'
                          ? 'measured regression — the rollback below is yours to run'
                          : 'human-only — records findings'}
                      </span>
                    </>
                  ) : null}
                </p>
                {selectedReviewerLine && (
                  <p data-testid="reviewer-line" className="mt-1.5 text-xs text-muted-foreground">
                    {selectedReviewerLine}
                  </p>
                )}
                <p className="mt-2 text-[0.8125rem] leading-relaxed text-foreground">{selected.problem}</p>
              </div>
              <div className="shrink-0 text-right">
                <span className="block text-2xs text-muted-foreground">
                  {STATUS_META[selected.status].label}
                </span>
                {selected.decidedAt && (
                  <span className="block text-2xs text-muted-foreground/70">
                    {formatTimeAgo(selected.decidedAt)}
                  </span>
                )}
              </div>
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
                  <Markdown content={draftedBody} demoteHeadings />
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
            {selected.applyResult?.trashId && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
                <span className="text-2xs text-muted-foreground">
                  Trashed as <code className="font-mono">{selected.applyResult.trashId}</code> —
                  restorable within 24 h
                </span>
                {/* The undo, in the place the decision was made. Without it the
                    trash id is an answer nobody asked for: the archive is a
                    move, so the restore route is what makes the move
                    reversible rather than merely non-destructive. */}
                <button
                  type="button"
                  disabled={busy || restoring}
                  onClick={() => void restoreArchived(selected)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-2xs font-medium transition hover:bg-muted/40 disabled:opacity-40"
                  data-testid="proposal-restore-archive"
                >
                  {restoring ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
                  Restore skill
                </button>
              </div>
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
                        : selected.kind === 'archive'
                          ? 'Move the skill into the delete trash — restore it from the result below'
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
        <div className="space-y-2" data-testid="proposal-queue">
          {(harnessQ.isLoading || memoryQ.isLoading) && (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          {!fetching && !harnessQ.isLoading && rows.length === 0 && (
            <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
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
          {/* Borderless hairline rows, the reference's list grammar: a status
              DOT, the sentence that says what is proposed, the evidence under
              it, and ONE muted metadata line at the right. The old row was a
              bordered card per proposal carrying a STACK of badges (status +
              kind + queue + a regression chip) over the same two lines — four
              pieces of chrome saying "this is a proposal" once each. */}
          <ul className="divide-y divide-border/60">
            {rows.map((p) => (
              <li
                key={rowKey(p)}
                data-testid={`proposal-row-${p.id}`}
                className="group flex items-center gap-3 px-2 py-2 transition-colors hover:bg-muted/40"
              >
                {p.status === 'open' ? (
                  <span className="w-3.5 shrink-0">
                    <input
                      type="checkbox"
                      checked={checked.has(rowKey(p))}
                      onChange={() => toggleCheck(p)}
                      aria-label={`Select ${p.problem}`}
                      data-testid={`proposal-select-${p.id}`}
                      className="size-3 accent-primary"
                    />
                  </span>
                ) : (
                  <span className="w-3.5 shrink-0" aria-hidden="true" />
                )}
                {/* The state is a DOT plus its word — never the colour alone.
                    The row used to carry a filled status PILL per proposal. */}
                <span className="flex w-20 shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
                  <span
                    className={cn('size-1.5 shrink-0 rounded-full', STATUS_META[p.status].dot)}
                    aria-hidden="true"
                  />
                  {STATUS_META[p.status].label}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedId(rowKey(p))}
                  className="min-w-0 flex-1 text-left"
                  data-testid={`proposal-open-${p.id}`}
                >
                  <span className="block truncate text-sm text-foreground">{p.problem}</span>
                  {p.evidence && (
                    <span className="block truncate text-2xs text-muted-foreground/80">
                      {p.evidence}
                    </span>
                  )}
                </button>
                <span
                  className="hidden shrink-0 items-center gap-1.5 text-2xs text-muted-foreground/70 sm:inline-flex"
                  title={`${p.kind} · ${p.queue}`}
                >
                  {p.kind === 'revert' && (
                    <span data-testid="measured-regression-tag" className="text-danger-fg">
                      regression
                    </span>
                  )}
                  <span className="font-mono">{p.kind}</span>
                  <span aria-hidden="true">·</span>
                  <span>{p.queue}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">
                    {p.createdAt ? formatTimeAgo(p.createdAt) : '—'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>
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
