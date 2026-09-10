/* ── LearningPanel ─────────────────────────────────────────────────────── */
/* The Learning section inside the Skills hub. Metric
 * header from the curator report, flagged episodes with fingerprint +
 * rubric score, distiller drafts inline with approve/reject (routed through
 * the existing human-gated proposals queue), and resolution counters.
 * Everything is read-only until a deliberate approve. */

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Check, ChevronDown, ChevronRight, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { useModels } from '@/hooks/useModels';
import { invalidateReviewInboxCount } from '@/lib/useReviewInboxCount';
import { CuratorSuggestionBar } from '@/sections/chat/CuratorSuggestionBar';

interface Rubric {
  score?: number;
  completion?: number;
  recurrence?: number;
  correctionCount?: number;
  recoveryQuality?: number;
  causeStability?: number;
  generalizability?: number;
}

interface FlaggedEpisode {
  id: number;
  kind: string;
  outcome: string;
  fingerprint: string;
  rubric: Rubric;
  createdAt?: string;
}

interface Proposal {
  id: string;
  kind: string;
  status: string;
  problem: string;
  proposal: string;
  payload?: { name?: string; fingerprint?: string; origin?: string };
}

interface RefineEntry {
  id: string;
  kind: string;
  scope: string;
  version: number;
  active: boolean;
  content?: { text?: string; name?: string; description?: string };
  rationale?: string;
  expectedOutcome?: string;
  updatedAt?: string;
}

interface RefineState {
  entries: RefineEntry[];
  config: { autoRefine?: boolean; producerModel?: string; reviewModel?: string };
  ledger: Array<{ at?: string; actor?: string; action?: string; entryId?: string; kind?: string }>;
}

/* P2 unified learning scheduler: cadence + last-run ledger for the
 * background passes. Without this the refine/consolidation writers look dead
 * between runs — the panel is the only surface that can say "it ran 3h ago
 * and kept 2 notes". */
interface SchedulerJob {
  job: string;
  intervalHours: number;
  lastRunAt: string | null;
  lastStatus: string;
  lastDurationS: number | null;
  nextDueAt: string | null;
  summary?: {
    observationsFiled?: number;
    promotionsFiled?: number;
    refine?: { status?: string; applied?: number };
    error?: string;
  };
}
interface SchedulerState {
  jobs: SchedulerJob[];
  runs: Array<{ job: string; finished_at?: string; status?: string }>;
}

const REFINE_PHRASE: Record<string, string> = {
  kept: 'kept',
  discarded: 'discarded by reviewer',
  'no-edits': 'no edits proposed',
  disabled: 'auto-refine off',
  skipped: 'no evidence',
  error: 'failed',
};

/** Compact relative time for ledger rows ("3h ago"); absolute fallback. */
function agoLabel(iso: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return iso;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (60 * 24))}d ago`;
}

interface Report {
  mode?: string;
  precision?: { labeled?: number; correct?: number; precision?: number; amendBodyEnabled?: boolean };
  learning?: {
    episodes?: number;
    tier2?: number;
    judged?: number;
    fingerprints?: number;
    flaggedFingerprints?: number;
    resolvedFingerprints?: number;
  };
  skillsIndexOverflow?: {
    budgetBytes?: number;
    listedSkills?: number;
    totalSkills?: number;
    omittedSkills?: number;
  } | null;
}

/** Part 27 D2: turn an internal episode fingerprint into a sentence a human
 *  can read. The corpus stays model-facing; this panel translates it. */
function prettify(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const KIND_PHRASE: Record<string, string> = {
  failure_recovery: 'Recovered from a failure',
  correction_accepted: 'Adapted after your correction',
  contested: 'Found a contradiction to resolve',
};

function describeEpisode(ep: FlaggedEpisode): string {
  const [scope, ...rest] = ep.fingerprint.split(':');
  const subject = prettify(rest.join(':'));
  const kindPhrase =
    KIND_PHRASE[ep.kind] ??
    (scope === 'tool-error'
      ? 'Recovered from a tool error'
      : scope === 'user-correction'
        ? 'Adapted after your correction'
        : prettify(ep.kind));
  const outcome = ep.outcome === 'resolved' ? 'resolved' : prettify(ep.outcome);
  return subject
    ? `${kindPhrase} — ${subject} · ${outcome}`
    : `${kindPhrase} · ${outcome}`;
}

export function LearningPanel() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const { models } = useModels();

  const reportQ = useQuery({
    queryKey: ['curator-report'],
    queryFn: () => api.get<Report>('/api/curator/report'),
  });
  const episodesQ = useQuery({
    queryKey: ['curator-episodes'],
    queryFn: () => api.get<{ episodes: FlaggedEpisode[] }>('/api/curator/episodes?limit=10'),
    enabled: expanded,
  });
  const draftsQ = useQuery({
    queryKey: ['harness-proposals', 'distilled'],
    queryFn: () =>
      api.get<{ proposals: Proposal[] }>(
        '/api/harness/proposals?status=open&origin=distilled',
      ),
    enabled: expanded,
  });
  const refineQ = useQuery({
    queryKey: ['curator-refine'],
    queryFn: () => api.get<RefineState>('/api/curator/refine'),
    enabled: expanded,
  });
  const schedulerQ = useQuery({
    queryKey: ['curator-scheduler'],
    queryFn: () => api.get<SchedulerState>('/api/curator/scheduler'),
    enabled: expanded,
    refetchInterval: 60_000, // cadence is hours; a minute-level tick keeps "last run" honest
  });

  const runJobNow = useMutation({
    mutationFn: (job: string) => api.post(`/api/curator/scheduler/run/${encodeURIComponent(job)}`),
    onSuccess: () => {
      toast.success('Job run finished — ledger updated');
      void qc.invalidateQueries({ queryKey: ['curator-scheduler'] });
      void qc.invalidateQueries({ queryKey: ['curator-refine'] });
      void qc.invalidateQueries({ queryKey: ['curator-report'] });
      invalidateReviewInboxCount(qc);
    },
    onError: (e: Error) => toast.error(e.message || 'Job run failed'),
  });

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['curator-report'] });
    void qc.invalidateQueries({ queryKey: ['curator-episodes'] });
    void qc.invalidateQueries({ queryKey: ['harness-proposals'] });
    void qc.invalidateQueries({ queryKey: ['curator-refine'] });
    invalidateReviewInboxCount(qc);
  }, [qc]);

  const rollbackRefine = useMutation({
    mutationFn: (id: string) => api.post(`/api/curator/refine/${encodeURIComponent(id)}/rollback`),
    onSuccess: () => {
      toast.success('Entry rolled back (undo is versioned — nothing is lost)');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message || 'Rollback failed'),
  });

  const setAutoRefine = useMutation({
    mutationFn: (on: boolean) =>
      api.post('/api/curator/refine/config', {
        autoRefine: on,
        ...(on &&
        refineQ.data?.config?.producerModel &&
        refineQ.data?.config?.producerModel === refineQ.data?.config?.reviewModel
          ? { reviewModel: '' }
          : {}),
      }),
    onSuccess: () => {
      toast.success(
        refineQ.data?.config?.autoRefine
          ? 'Auto-refine turned off'
          : 'Auto-refine on — passes ride the consolidation cadence behind an independent reviewer',
      );
      void qc.invalidateQueries({ queryKey: ['curator-refine'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Config update failed'),
  });

  const setRefineModels = useMutation({
    mutationFn: (patch: { producerModel?: string; reviewModel?: string }) =>
      api.post('/api/curator/refine/config', patch),
    onSuccess: () => {
      toast.success('Refine model pins updated');
      void qc.invalidateQueries({ queryKey: ['curator-refine'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Model pin update failed'),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
      api.post(`/api/harness/proposals/${encodeURIComponent(id)}/decide`, { decision, note: '' }),
    onSuccess: (_d, vars) => {
      toast.success(vars.decision === 'approve' ? 'Draft approved' : 'Draft rejected');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message || 'Decision failed'),
  });

  const runPass = () => {
    if (running) return;
    setRunning(true);
    void api
      .post('/api/curator/run')
      .then(() => {
        toast.success('Learning pass finished');
        refresh();
      })
      .catch((e: Error) => toast.error(e.message || 'Learning pass failed'))
      .finally(() => setRunning(false));
  };

  const learning = reportQ.data?.learning ?? {};
  const precision = reportQ.data?.precision;
  const metrics: Array<[string, number | string | undefined]> = [
    ['Episodes', learning.episodes],
    ['Tier 2', learning.tier2],
    ['Judged', learning.judged],
    ['Fingerprints', learning.fingerprints],
    ['Resolved', learning.resolvedFingerprints],
    [
      'Precision',
      precision && precision.labeled
        ? `${Math.round((precision.precision ?? 0) * 100)}% (${precision.labeled})`
        : '—',
    ],
  ];

  // One plain-language line in the collapsed header; the raw
  // telemetry chips move behind the expand ("Details").
  const patterns = learning.fingerprints ?? 0;
  const promoted = learning.judged ?? 0;
  const summaryLine =
    (learning.episodes ?? 0) === 0
      ? 'August has not learned anything yet — run a learning pass after real sessions.'
      : `August has learned from ${learning.episodes} recent session${learning.episodes === 1 ? '' : 's'} · ${patterns} pattern${patterns === 1 ? '' : 's'} tracked · ${promoted > 0 ? `${promoted} reviewed` : 'nothing promoted yet'}`;

  return (
    <div
      className="shrink-0 rounded-xl border border-border/60 bg-card/40"
      data-testid="learning-panel"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" />
        )}
        <Brain className="size-3.5 text-primary" />
        <span className="text-sm font-medium text-foreground">Learning</span>
        <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-muted-foreground">
          {summaryLine}
        </span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border/60 px-4 py-3">
          {/* Raw telemetry behind an explicit expand (D3). */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Details
            </span>
            {metrics.map(([label, value]) => (
              <span
                key={label}
                data-testid={`learning-metric-${label.toLowerCase()}`}
                className="rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                {label} {value ?? '—'}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runPass}
              disabled={running || reportQ.data?.mode === 'off'}
              data-testid="learning-run-pass"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1 text-[11px] text-foreground transition hover:border-primary/40 disabled:opacity-50"
            >
              {running ? <Loader2 className="size-3 animate-spin" /> : null}
              Run learning pass
            </button>
            <CuratorSuggestionBar />
            {reportQ.data?.mode === 'off' && (
              <span className="text-[10.5px] text-muted-foreground">
                skillLearning is off — enable it in Brain settings
              </span>
            )}
            {reportQ.data?.skillsIndexOverflow && (
              <span
                data-testid="learning-skills-index-overflow"
                className="text-[10.5px] text-amber-600 dark:text-amber-400"
                title="The skills catalogue outgrew the prompt byte budget; some skills are packed out of the descriptive index."
              >
                Skills index over budget —{' '}
                {reportQ.data.skillsIndexOverflow.omittedSkills ?? 0} skill(s) not listed in
                prompts
              </span>
            )}
          </div>

          {/* Flagged episodes */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Flagged episodes
            </p>
            {!episodesQ.data?.episodes?.length ? (
              <p className="text-xs text-muted-foreground">
                No flagged episodes yet — they appear after a learning pass flags recurring
                failure patterns.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {episodesQ.data.episodes.map((ep) => (
                  <li
                    key={ep.id}
                    data-testid="learning-episode"
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card/60 px-3 py-1.5 text-xs"
                  >
                    <span className="min-w-0 truncate text-foreground/90" title={ep.fingerprint}>
                      {describeEpisode(ep)}
                    </span>
                    <span className="shrink-0 rounded-full bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
                      confidence {typeof ep.rubric?.score === 'number' ? ep.rubric.score.toFixed(2) : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Distiller drafts */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Distiller drafts ({draftsQ.data?.proposals?.length ?? 0})
            </p>
            {!draftsQ.data?.proposals?.length ? (
              <p className="text-xs text-muted-foreground">
                No open drafts. The judge only drafts after human review gates pass.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {draftsQ.data.proposals.map((p) => (
                  <li
                    key={p.id}
                    data-testid="learning-draft"
                    className="rounded-lg border border-border/50 bg-card/60 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {p.payload?.name || p.problem}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          data-testid={`learning-approve-${p.id}`}
                          onClick={() => decide.mutate({ id: p.id, decision: 'approve' })}
                          disabled={decide.isPending}
                          className="rounded p-1 text-success hover:bg-success/10"
                          aria-label="Approve draft"
                        >
                          <Check className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid={`learning-reject-${p.id}`}
                          onClick={() => decide.mutate({ id: p.id, decision: 'reject' })}
                          disabled={decide.isPending}
                          className="rounded p-1 text-destructive hover:bg-destructive/10"
                          aria-label="Reject draft"
                        >
                          <X className="size-3.5" />
                        </button>
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-muted-foreground">{p.proposal}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* P2: the unified scheduler's ledger — cadence + last-run per
              background job, so a 24h writer never looks dead. Manual "run"
              rides the same code path (and ledger) the cadence uses. */}
          <div data-testid="learning-scheduler">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Background jobs
            </p>
            {!schedulerQ.data?.jobs?.length ? (
              <p className="text-xs text-muted-foreground">
                Scheduler status unavailable — the learning loop runs on its cadence anyway.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {schedulerQ.data.jobs.map((j) => {
                  const refine = j.summary?.refine;
                  const filed =
                    j.job === 'introspection'
                      ? [
                          j.summary?.observationsFiled ? `${j.summary.observationsFiled} observation(s) filed` : null,
                          j.summary?.promotionsFiled ? `${j.summary.promotionsFiled} promotion(s) filed` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : '';
                  const outcome = refine
                    ? `refine: ${REFINE_PHRASE[refine.status ?? ''] ?? refine.status}` +
                      (refine.status === 'kept' && refine.applied ? ` (${refine.applied} applied)` : '')
                    : filed || (j.summary?.error ? String(j.summary.error).slice(0, 80) : '');
                  return (
                    <li
                      key={j.job}
                      data-testid={`learning-scheduler-job-${j.job}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card/60 px-3 py-1.5 text-xs"
                    >
                      <span className="min-w-0">
                        <span className="font-medium text-foreground/90">{j.job}</span>
                        <span className="ml-2 text-[10.5px] text-muted-foreground" title={j.lastRunAt ?? undefined}>
                          every {j.intervalHours}h · last {agoLabel(j.lastRunAt)}
                          {j.lastStatus === 'error' ? ' · errored' : ''}
                          {outcome ? ` · ${outcome}` : ''}
                        </span>
                      </span>
                      <button
                        type="button"
                        data-testid={`learning-scheduler-run-${j.job}`}
                        onClick={() => runJobNow.mutate(j.job)}
                        disabled={runJobNow.isPending}
                        className="shrink-0 rounded-lg border border-border/60 bg-muted/30 px-2 py-0.5 text-[10.5px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:opacity-50"
                      >
                        {runJobNow.isPending && runJobNow.variables === j.job ? 'running…' : 'run now'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Refine store — the versioned harness-state notes that inject into
              every prompt. Written by gated auto-refine passes (independent
              reviewer, discard-default, rollback on reject); every row here is
              a diff you can undo. */}
          <div data-testid="learning-refine">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Refine store ({refineQ.data?.entries?.length ?? 0} active)
              </p>
              <label className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <input
                  type="checkbox"
                  data-testid="learning-auto-refine"
                  className="size-3 accent-primary"
                  checked={!!refineQ.data?.config?.autoRefine}
                  disabled={setAutoRefine.isPending}
                  onChange={(e) => setAutoRefine.mutate(e.target.checked)}
                />
                Auto-refine
              </label>
            </div>
            {/* UI suggestion 5: model pins for the gated pass. Producer writes
                the batch, reviewer (a DIFFERENT model — the backend refuses
                equal pairs when auto-refine is on) judges it discard-default.
                Empty = provider default per pin. */}
            <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px] text-muted-foreground">
              <label className="flex min-w-0 items-center gap-1.5" data-testid="learning-refine-producer-row">
                <span className="shrink-0">producer</span>
                <select
                  data-testid="learning-refine-producer"
                  className="max-w-[220px] truncate rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10.5px] text-foreground focus:border-primary/40 focus:outline-none"
                  value={refineQ.data?.config?.producerModel ?? ''}
                  disabled={setRefineModels.isPending}
                  onChange={(e) => setRefineModels.mutate({ producerModel: e.target.value })}
                >
                  <option value="">default</option>
                  {models.map((m) => (
                    <option key={`p-${m.provider}-${m.id}`} value={m.id}>
                      {m.name || m.id} · {m.provider}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 items-center gap-1.5" data-testid="learning-refine-reviewer-row">
                <span className="shrink-0">reviewer</span>
                <select
                  data-testid="learning-refine-reviewer"
                  className="max-w-[220px] truncate rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10.5px] text-foreground focus:border-primary/40 focus:outline-none"
                  value={refineQ.data?.config?.reviewModel ?? ''}
                  disabled={setRefineModels.isPending}
                  onChange={(e) => setRefineModels.mutate({ reviewModel: e.target.value })}
                >
                  <option value="">default</option>
                  {models.map((m) => (
                    <option key={`r-${m.provider}-${m.id}`} value={m.id}>
                      {m.name || m.id} · {m.provider}
                    </option>
                  ))}
                </select>
              </label>
              {refineQ.data?.config?.autoRefine &&
                refineQ.data?.config?.producerModel &&
                refineQ.data?.config?.producerModel === refineQ.data?.config?.reviewModel && (
                  <span data-testid="learning-refine-same-model" className="text-amber-600 dark:text-amber-400">
                    producer and reviewer are the same model — passes will be discarded
                  </span>
                )}
            </div>
            {!refineQ.data?.entries?.length ? (
              <p className="text-xs text-muted-foreground">
                {refineQ.data?.config?.autoRefine
                  ? 'Auto-refine is on — notes appear after the next consolidation pass finds evidence worth keeping.'
                  : 'Empty. Enable auto-refine to let gated passes (producer + a different-model reviewer, rollback on reject) write durable notes here — or leave it off and nothing injects.'}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {refineQ.data.entries.map((en) => (
                  <li
                    key={en.id}
                    data-testid="learning-refine-entry"
                    className="flex items-start justify-between gap-2 rounded-lg border border-border/50 bg-card/60 px-3 py-1.5 text-xs"
                  >
                    <span className="min-w-0">
                      <span className="mr-1.5 inline-block rounded-full border border-border/60 bg-muted/30 px-1.5 py-px text-[9px] uppercase text-muted-foreground">
                        {en.kind} · {en.scope} · v{en.version}
                      </span>
                      <span className="text-foreground/90">
                        {en.content?.text || en.content?.name || en.id}
                      </span>
                      {en.rationale ? (
                        <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground" title={en.rationale}>
                          why: {en.rationale}
                        </span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      data-testid={`learning-refine-rollback-${en.id}`}
                      onClick={() => rollbackRefine.mutate(en.id)}
                      disabled={rollbackRefine.isPending}
                      title="Roll back the newest version (undo is itself versioned)"
                      aria-label={`Roll back refine entry ${en.id}`}
                      className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                    >
                      <RotateCcw className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(refineQ.data?.ledger?.length ?? 0) > 0 && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[10.5px] text-muted-foreground">
                  Recent refine journal
                </summary>
                <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground/80">
                  {refineQ.data!.ledger.slice(-6).reverse().map((row, i) => (
                    <li key={i} className="flex items-center gap-1.5 truncate">
                      <Sparkles className="size-2.5 shrink-0" />
                      {row.at} · {row.actor} · {row.action} {row.kind ?? ''} {row.entryId ?? ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
