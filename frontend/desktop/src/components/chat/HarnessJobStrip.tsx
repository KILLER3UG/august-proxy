/* Horizontal wave ribbon — running / waiting / dirty as pills, not a log. */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as subagents from '@/api/subagents';
import { setContinueWorkstream } from '@/components/chat/composer-intent';

function laneTone(
  outcomes: Record<string, { status?: string; error?: string }> | undefined,
  name: string,
  jobStatus: string,
  dirty?: boolean,
) {
  const st = (outcomes?.[name]?.status || '').toLowerCase();
  if (st === 'continuing') return 'running';
  if (st === 'completed' || st === 'done') return 'done';
  if (st === 'skipped') return 'skipped';
  if (st === 'failed' || st === 'error' || st === 'blocked') return 'failed';
  if (st === 'partial') return 'warning';
  if (dirty && jobStatus !== 'running') return 'warning';
  if (jobStatus === 'running') return 'idle';
  return 'idle';
}

export function HarnessJobStrip({ sessionId }: { sessionId: string | null }) {
  const qc = useQueryClient();
  const jobs = useQuery({
    queryKey: ['harness-jobs', sessionId],
    queryFn: () => subagents.listJobs(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 6_000,
  });
  const rows = (jobs.data ?? []).filter(
    (j) => j.dirty || j.status === 'running' || j.status === 'failed' || j.status === 'partial',
  );
  if (!sessionId || rows.length === 0) return null;
  const job = rows[0];

  return (
    <div
      className="mb-2 rounded-xl border border-border/40 bg-muted/15 px-2.5 py-2"
      data-testid="harness-job-strip"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-foreground/85">
          {job.status === 'running' ? 'Dispatching' : job.dirty ? 'Needs a handoff' : 'Waves'}
        </span>
        {job.dirty ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-warning">
            <AlertTriangle className="size-3" />
            dirty
          </span>
        ) : null}
        {job.status === 'running' ? (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Stop this wave"
              onClick={() => {
                const live = Object.entries(job.outcomes ?? {})
                  .filter(([, o]) => (o.status || '').toLowerCase() === 'running')
                  .map(([n]) => n);
                const idx = (job.waves ?? []).findIndex((w) =>
                  w.some((n) => live.includes(n)),
                );
                void subagents
                  .cancelWave(job.id, Math.max(0, idx))
                  .then(() => {
                    void qc.invalidateQueries({ queryKey: ['harness-jobs'] });
                  });
              }}
            >
              Stop wave
            </button>
            <button
              type="button"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Cancel job"
              onClick={() => {
                void subagents.cancelJob(job.id).then(() => {
                  void qc.invalidateQueries({ queryKey: ['harness-jobs'] });
                });
              }}
            >
              <Square className="size-3" />
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {(job.waves ?? []).flatMap((wave, wi) =>
          wave.filter(Boolean).map((name, ni) => {
            const tone = laneTone(job.outcomes, name, job.status, job.dirty);
            const err = job.outcomes?.[name]?.error;
            return (
              <span key={`${wi}-${name}-${ni}`} className="inline-flex items-center gap-1">
                {wi > 0 && ni === 0 ? (
                  <span className="px-0.5 text-[11px] text-muted-foreground/40">→</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => setContinueWorkstream(name)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] transition',
                    tone === 'running' &&
                      'border-primary/40 bg-primary/10 text-foreground',
                    tone === 'done' && 'border-success/30 bg-success/10 text-foreground/80',
                    tone === 'failed' && 'border-destructive/40 text-destructive',
                    tone === 'skipped' && 'border-border/50 text-muted-foreground line-through',
                    tone === 'warning' && 'border-warning/40 bg-warning/10 text-warning',
                    tone === 'idle' && 'border-border/50 text-muted-foreground',
                  )}
                  title={err || name}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      tone === 'running' && 'animate-pulse bg-primary',
                      tone === 'done' && 'bg-success',
                      tone === 'failed' && 'bg-destructive',
                      tone === 'warning' && 'bg-warning',
                      tone === 'skipped' && 'bg-muted-foreground/35',
                    )}
                  />
                  {name}
                </button>
              </span>
            );
          }),
        )}
      </div>
      {job.dirty ? (
        <button
          type="button"
          className="mt-1.5 text-[12px] text-warning underline-offset-2 hover:underline"
          onClick={() => {
            const names = (job.waves ?? []).flat().filter(Boolean);
            const name = names[names.length - 1];
            if (!name || !sessionId) return;
            void subagents
              .continueWorkstream(
                sessionId,
                name,
                'Continue from the last episode.',
              )
              .then(() => {
                void qc.invalidateQueries({ queryKey: ['harness-jobs'] });
              });
          }}
        >
          Continue from last episode
        </button>
      ) : null}
    </div>
  );
}
