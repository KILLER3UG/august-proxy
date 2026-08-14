/* Named workstreams + latest episode (Nac-style thread dashboard). */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, Play, Square } from 'lucide-react';
import * as subagents from '@/api/subagents';
import { useSubagentActions } from '@/hooks/useSubagentActions';
import { setContinueWorkstream } from '@/components/chat/composer-intent';

export function WorkstreamsPanel({
  sessionId,
  compact = false,
}: {
  sessionId: string | null;
  compact?: boolean;
}) {
  const { continueStream } = useSubagentActions();
  const [openName, setOpenName] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState('');
  const query = useQuery({
    queryKey: ['workstreams', sessionId],
    queryFn: () => subagents.listWorkstreams(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 8_000,
  });
  const jobs = useQuery({
    queryKey: ['harness-jobs', sessionId],
    queryFn: () => subagents.listJobs(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 8_000,
  });
  const episodes = useQuery({
    queryKey: ['workstream-episodes', sessionId, openName],
    queryFn: () => subagents.listWorkstreamEpisodes(sessionId!, openName!),
    enabled: !!sessionId && !!openName,
  });

  const rows = query.data ?? [];
  const jobRows = jobs.data ?? [];
  if (!sessionId) return null;
  if (rows.length === 0 && jobRows.length === 0 && !query.isFetching) {
    if (compact) return null;
    return (
      <p className="px-2 py-2 text-xs text-muted-foreground/60">
        No named workstreams yet. Spawn with a <code>name</code> / <code>workstream</code> to keep
        episode history.
      </p>
    );
  }

  return (
    <div className={compact ? 'px-2 py-2' : 'space-y-2'} data-testid="workstreams-panel">
      {jobRows.length > 0 ? (
        <div className="mb-2 space-y-1" data-testid="harness-jobs">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Jobs
          </div>
          {jobRows.slice(0, compact ? 3 : 8).map((job) => (
            <div
              key={job.id}
              className="rounded border border-border/40 px-2 py-1 text-[11px]"
              data-testid={`harness-job-${job.id}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-muted-foreground">{job.status}</span>
                {job.dirty ? <span className="text-amber-600">dirty</span> : null}
                {job.status === 'running' ? (
                  <button
                    type="button"
                    className="ml-auto text-muted-foreground hover:text-foreground"
                    title="Cancel job"
                    onClick={() => void subagents.cancelJob(job.id)}
                  >
                    <Square className="size-3" />
                  </button>
                ) : null}
              </div>
              {(job.waves ?? []).map((wave, i) => (
                <p key={i} className="text-muted-foreground/80">
                  wave {i + 1}:{' '}
                  {wave.filter(Boolean).map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="mr-1 font-mono underline-offset-2 hover:underline"
                      onClick={() => {
                        setOpenName(name);
                        setContinueWorkstream(name);
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </p>
              ))}
              {job.dirty ? (
                <button
                  type="button"
                  className="mt-0.5 text-[10px] text-amber-600 underline"
                  onClick={() => {
                    const n = job.waves?.flat().find(Boolean);
                    if (n) setContinueWorkstream(n);
                  }}
                >
                  Recover: continue thread and summarize mutations
                </button>
              ) : null}
              {job.error ? <p className="text-destructive/80">{job.error}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <GitBranch className="size-3" />
        Workstreams
        <span className="tabular-nums text-muted-foreground/55">{rows.length}</span>
      </div>
      <ul className="space-y-1">
        {rows.map((ws) => (
          <li key={ws.name} className="rounded-md border border-border/50 bg-muted/10">
            <button
              type="button"
              className="flex w-full items-start gap-2 px-2 py-1.5 text-left"
              onClick={() => {
                setOpenName((n) => (n === ws.name ? null : ws.name));
                setContinueWorkstream(ws.name);
              }}
              data-testid={`workstream-${ws.name}`}
            >
              <span className="font-mono text-[11px] text-foreground/90">{ws.name}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {ws.latest?.status ?? 'empty'}
              </span>
            </button>
            {ws.latest?.summary ? (
              <p className="line-clamp-2 px-2 pb-1.5 text-[11px] text-muted-foreground/80">
                {ws.latest.summary}
              </p>
            ) : null}
            {openName === ws.name ? (
              <div className="space-y-1.5 border-t border-border/40 px-2 py-2">
                {(episodes.data ?? []).map((ep) => (
                  <div key={ep.seq} className="text-[11px]">
                    <span className="font-mono text-muted-foreground">#{ep.seq}</span>{' '}
                    <span className="text-muted-foreground/70">{ep.status}</span>
                    <p className="whitespace-pre-wrap text-foreground/80">{ep.summary}</p>
                  </div>
                ))}
                <form
                  className="flex gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const msg = followUp.trim();
                    if (!msg) return;
                    continueStream.mutate({ sessionId, name: ws.name, message: msg });
                    setFollowUp('');
                  }}
                >
                  <input
                    value={openName === ws.name ? followUp : ''}
                    onChange={(e) => setFollowUp(e.target.value)}
                    className="min-w-0 flex-1 rounded border border-border/60 bg-background px-1.5 py-1 text-[11px]"
                    placeholder="Continue this thread…"
                    aria-label={`Continue workstream ${ws.name}`}
                  />
                  <button
                    type="submit"
                    disabled={continueStream.isPending}
                    className="rounded border border-border/60 px-1.5 py-1 text-muted-foreground hover:text-foreground"
                    title="Continue workstream"
                  >
                    <Play className="size-3" />
                  </button>
                </form>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
