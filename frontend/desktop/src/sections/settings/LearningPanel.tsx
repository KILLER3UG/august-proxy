/* ── LearningPanel ─────────────────────────────────────────────────────── */
/* Part 16 Phase E: the Learning section inside the Skills hub. Metric
 * header from the curator report, flagged episodes with fingerprint +
 * rubric score, distiller drafts inline with approve/reject (routed through
 * the existing human-gated proposals queue), and resolution counters.
 * Everything is read-only until a deliberate approve. */

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
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

export function LearningPanel() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);

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

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['curator-report'] });
    void qc.invalidateQueries({ queryKey: ['curator-episodes'] });
    void qc.invalidateQueries({ queryKey: ['harness-proposals'] });
  }, [qc]);

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
        <span className="flex flex-1 flex-wrap items-center justify-end gap-1.5">
          {metrics.map(([label, value]) => (
            <span
              key={label}
              data-testid={`learning-metric-${label.toLowerCase()}`}
              className="rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {label} {value ?? '—'}
            </span>
          ))}
        </span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border/60 px-4 py-3">
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
                    <span className="min-w-0">
                      <span className="font-mono text-[11px] text-foreground">{ep.fingerprint}</span>
                      <span className="ml-2 text-muted-foreground">
                        {ep.kind} · {ep.outcome}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
                      score {typeof ep.rubric?.score === 'number' ? ep.rubric.score.toFixed(2) : '—'}
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
        </div>
      )}
    </div>
  );
}
