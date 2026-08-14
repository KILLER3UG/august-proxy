/* Horizontal wave ribbon — running / waiting / dirty as pills, not a log. */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as subagents from '@/api/subagents';
import { setContinueWorkstream } from '@/components/chat/composer-intent';

function waveTone(jobStatus: string, waveIndex: number, dirty?: boolean) {
  if (dirty && jobStatus !== 'running') return 'warning';
  if (jobStatus === 'running' && waveIndex === 0) return 'running';
  if (jobStatus === 'completed') return 'done';
  if (jobStatus === 'failed' || jobStatus === 'partial') return 'failed';
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
  const rows = (jobs.data ?? []).filter((j) => j.dirty);
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
          <button
            type="button"
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Cancel job"
            onClick={() => {
              void subagents.cancelJob(job.id).then(() => {
                void qc.invalidateQueries({ queryKey: ['harness-jobs'] });
              });
            }}
          >
            <Square className="size-3" />
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {(job.waves ?? []).flatMap((wave, wi) =>
          wave.filter(Boolean).map((name, ni) => {
            const tone = waveTone(job.status, wi, job.dirty);
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
                    tone === 'warning' && 'border-warning/40 bg-warning/10 text-warning',
                    tone === 'idle' && 'border-border/50 text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      tone === 'running' && 'animate-pulse bg-primary',
                      tone === 'done' && 'bg-success',
                      tone === 'failed' && 'bg-destructive',
                      tone === 'warning' && 'bg-warning',
                      tone === 'idle' && 'bg-muted-foreground/40',
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
                'Summarize what changed in this workstream, then continue from the last episode.',
              )
              .then(() => {
                void qc.invalidateQueries({ queryKey: ['harness-jobs'] });
              });
          }}
        >
          Summarize what changed and continue
        </button>
      ) : null}
    </div>
  );
}
