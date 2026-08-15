/* Worker inbox: dirty threads, specialists, routines, jobs. */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import * as subagents from '@/api/subagents';
import { useSubagentActions } from '@/hooks/useSubagentActions';
import { EpisodeCard } from '@/components/chat/EpisodeCard';
import { setContinueWorkstream } from '@/components/chat/composer-intent';

const AUTONOMY_CYCLE = ['ask', 'on_fail', 'silent'] as const;

function autonomyLabel(mode?: string) {
  if (mode === 'silent') return 'keep going';
  if (mode === 'on_fail') return 'ping on fail';
  return 'always ping';
}

export function WorkstreamsPanel({
  sessionId,
  compact = false,
  workspacePath,
}: {
  sessionId: string | null;
  compact?: boolean;
  workspacePath?: string | null;
}) {
  const qc = useQueryClient();
  const { continueStream } = useSubagentActions();
  const [openName, setOpenName] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState('');
  const [search, setSearch] = useState('');
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
  const digest = useQuery({
    queryKey: ['harness-digest', sessionId],
    queryFn: () => subagents.getDigest(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 12_000,
  });
  const episodes = useQuery({
    queryKey: ['workstream-episodes', sessionId, openName],
    queryFn: () => subagents.listWorkstreamEpisodes(sessionId!, openName!),
    enabled: !!sessionId && !!openName,
  });

  const searchQ = useQuery({
    queryKey: ['harness-search', sessionId, search],
    queryFn: () => subagents.searchHarness(sessionId!, search),
    enabled: !!sessionId && search.trim().length >= 2,
  });
  const saveSkill = useMutation({
    mutationFn: ({ workstream, seq }: { workstream: string; seq: number }) =>
      subagents.saveSkillFromEpisode(sessionId!, workstream, seq),
    onSuccess: (res) => toast.success(`Saved skill ${res.name || ''}`),
    onError: () => toast.error('Could not save skill'),
  });
  const saveRoutine = useMutation({
    mutationFn: ({ workstream, seq }: { workstream: string; seq: number }) =>
      subagents.saveRoutineFromEpisode(sessionId!, workstream, seq),
    onSuccess: () => {
      toast.success('Saved as routine');
      void qc.invalidateQueries({ queryKey: ['harness-digest'] });
    },
    onError: () => toast.error('Could not save routine'),
  });
  const runRoutine = useMutation({
    mutationFn: (id: string) => subagents.runRoutine(sessionId!, id),
    onSuccess: () => {
      toast.success('Routine running');
      void qc.invalidateQueries({ queryKey: ['harness-jobs'] });
      void qc.invalidateQueries({ queryKey: ['workstreams'] });
    },
  });
  const claimSpecialist = useMutation({
    mutationFn: (workstream: string) =>
      subagents.upsertSpecialist(sessionId!, {
        name: workstream,
        workstream,
        autonomy: 'ask',
        workspacePath: workspacePath || undefined,
      }),
    onSuccess: () => {
      toast.success('Specialist saved');
      void qc.invalidateQueries({ queryKey: ['workstreams'] });
      void qc.invalidateQueries({ queryKey: ['harness-digest'] });
    },
  });
  const pauseRoutine = useMutation({
    mutationFn: ({ id, paused, schedule }: { id: string; paused: boolean; schedule?: string }) =>
      subagents.scheduleRoutine(id, schedule ?? '', paused),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['harness-digest'] });
    },
  });
  const cycleAutonomy = useMutation({
    mutationFn: ({ id, autonomy }: { id: string; autonomy: string }) =>
      subagents.setSpecialistAutonomy(id, autonomy),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstreams'] });
      void qc.invalidateQueries({ queryKey: ['harness-digest'] });
    },
  });

  const rows = useMemo(() => {
    const list = [...(query.data ?? [])];
    list.sort((a, b) => Number(!!b.dirty) - Number(!!a.dirty));
    return list;
  }, [query.data]);
  const jobRows = jobs.data ?? [];
  const routines = digest.data?.routines ?? [];
  const needs = digest.data?.needsHandoff ?? [];
  if (!sessionId) return null;
  if (rows.length === 0 && jobRows.length === 0 && routines.length === 0 && !query.isFetching) {
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
      {digest.data?.unattended ? (
        <p className="mb-2 rounded-lg border border-border/40 px-2 py-1.5 text-[11px] text-muted-foreground">
          Idle over 24h — scheduled routines and silent hops are paused until you send again.
        </p>
      ) : null}
      {!compact ? (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-2 w-full rounded border border-border/60 bg-background px-1.5 py-1 text-[11px]"
          placeholder="Search lanes, episodes, routines…"
          aria-label="Search workstreams"
        />
      ) : null}
      {search.trim().length >= 2 && (searchQ.data?.hits?.length ?? 0) > 0 ? (
        <ul className="mb-2 space-y-0.5 text-[11px]" data-testid="harness-search-hits">
          {searchQ.data!.hits!.slice(0, 8).map((hit, i) => (
            <li key={i}>
              <button
                type="button"
                className="w-full truncate text-left text-muted-foreground hover:text-foreground"
                onClick={() => {
                  const name = String(hit.workstream || hit.name || '');
                  if (name) {
                    setOpenName(name);
                    setContinueWorkstream(name);
                  }
                }}
              >
                {String(hit.kind || '')} · {String(hit.workstream || hit.name || '')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {needs.length > 0 || (digest.data?.running ?? 0) > 0 ? (
        <div
          className="mb-2 rounded-lg border border-border/40 bg-muted/10 px-2 py-1.5 text-[11px]"
          data-testid="harness-digest"
        >
          <span className="text-muted-foreground">
            {digest.data?.running ? `${digest.data.running} running` : 'Idle'}
            {needs.length ? ` · ${needs.length} need a handoff` : ''}
          </span>
          {needs.slice(0, compact ? 2 : 5).map((n) => (
            <button
              key={n.workstream}
              type="button"
              className="mt-0.5 block w-full truncate text-left text-warning hover:underline"
              onClick={() => {
                setOpenName(n.workstream);
                setContinueWorkstream(n.workstream);
              }}
            >
              {n.workstream}
              {n.next ? ` → ${n.next}` : ''}
            </button>
          ))}
        </div>
      ) : null}
      {routines.length > 0 ? (
        <div className="mb-2 space-y-1" data-testid="harness-routines">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Routines
          </div>
          {routines.slice(0, compact ? 3 : 8).map((rtn) => (
            <div key={rtn.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="min-w-0 truncate font-mono">{rtn.name}</span>
              {rtn.paused ? <span className="text-muted-foreground/70">paused</span> : null}
              <button
                type="button"
                className="ml-auto rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => runRoutine.mutate(rtn.id)}
              >
                Run
              </button>
              {!compact ? (
                <>
                  <input
                    defaultValue={rtn.schedule || ''}
                    className="w-24 rounded border border-border/50 bg-background px-1 py-0.5 font-mono text-[10px]"
                    placeholder="cron"
                    aria-label={`Schedule ${rtn.name}`}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      void subagents.scheduleRoutine(rtn.id, v, rtn.paused);
                    }}
                  />
                  <button
                    type="button"
                    className="text-[10px] text-muted-foreground hover:underline"
                    onClick={() =>
                      pauseRoutine.mutate({
                        id: rtn.id,
                        paused: !rtn.paused,
                        schedule: rtn.schedule,
                      })
                    }
                  >
                    {rtn.paused ? 'Resume' : 'Pause'}
                  </button>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
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
        Inbox
        <span className="tabular-nums text-muted-foreground/55">{rows.length}</span>
      </div>
      <ul className="space-y-1">
        {rows.map((ws) => (
          <li
            key={ws.name}
            className={
              ws.attention === 'needs' || ws.dirty
                ? 'rounded-md border border-warning/40 bg-warning/5'
                : ws.attention === 'working'
                  ? 'rounded-md border border-primary/30 bg-primary/5'
                  : ws.attention === 'unread'
                    ? 'rounded-md border border-border/70 bg-muted/20'
                    : 'rounded-md border border-border/50 bg-muted/10'
            }
          >
            <button
              type="button"
              className="flex w-full items-start gap-2 px-2 py-1.5 text-left"
              onClick={() => {
                setOpenName((n) => (n === ws.name ? null : ws.name));
                setContinueWorkstream(ws.name);
                void subagents.markWorkstreamRead(sessionId, ws.name);
              }}
              data-testid={`workstream-${ws.name}`}
            >
              {ws.dirty ? (
                <span className="mt-1 size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
              ) : null}
              <span className="font-mono text-[11px] text-foreground/90">{ws.name}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {ws.attention === 'working'
                  ? 'working'
                  : ws.attention === 'needs'
                    ? 'needs you'
                    : ws.unread
                      ? 'unread'
                      : (ws.latest?.status ?? 'empty')}
              </span>
            </button>
            {ws.latest?.next || ws.latest?.summary ? (
              <p className="line-clamp-2 px-2 pb-1.5 text-[11px] text-muted-foreground/80">
                {ws.latest.next || ws.latest.summary}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5">
              {ws.specialist ? (
                <button
                  type="button"
                  className="rounded-full border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  title="Cycle ping vs keep going"
                  onClick={() => {
                    const cur = ws.specialist?.autonomy || 'ask';
                    const idx = AUTONOMY_CYCLE.indexOf(cur as (typeof AUTONOMY_CYCLE)[number]);
                    const next = AUTONOMY_CYCLE[(idx + 1) % AUTONOMY_CYCLE.length];
                    cycleAutonomy.mutate({ id: ws.specialist!.id, autonomy: next });
                  }}
                >
                  {autonomyLabel(ws.specialist.autonomy)}
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-full border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => claimSpecialist.mutate(ws.name)}
                >
                  Save specialist
                </button>
              )}
            </div>
            {openName === ws.name ? (
              <div className="space-y-1.5 border-t border-border/40 px-2 py-2">
                {(episodes.data ?? []).map((ep) => (
                  <EpisodeCard
                    key={ep.seq}
                    episode={ep}
                    onContinue={(next) => {
                      continueStream.mutate({
                        sessionId,
                        name: ws.name,
                        message: next || 'Continue from the last episode.',
                      });
                    }}
                    onSaveRoutine={(seq) => saveRoutine.mutate({ workstream: ws.name, seq })}
                    onSaveSkill={(seq) => saveSkill.mutate({ workstream: ws.name, seq })}
                  />
                ))}
                <form
                  className="flex gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const msg = followUp.trim() || ws.latest?.next || 'Continue from the last episode.';
                    continueStream.mutate({ sessionId, name: ws.name, message: msg });
                    setFollowUp('');
                  }}
                >
                  <input
                    value={openName === ws.name ? followUp : ''}
                    onChange={(e) => setFollowUp(e.target.value)}
                    className="min-w-0 flex-1 rounded border border-border/60 bg-background px-1.5 py-1 text-[11px]"
                    placeholder={ws.latest?.next || 'Continue this thread…'}
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