/* Sticky run header — mode · wave · context · live workers. */

import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import * as subagents from '@/api/subagents';
import { normalizeHarnessMode } from '@/components/chat/HarnessModeChip';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';
import type { WorkbenchSession } from '@/types/workbench';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { resolveActiveWave } from '@/components/chat/harness-wave';

const MODE_LABEL: Record<string, string> = {
  agent: 'Agent',
  orchestrator: 'Orchestrator',
  chat: 'Chat',
  code: 'Code',
};

export function ChatRunHeader({
  workbenchSession,
  pct,
  streaming,
  subagentBlocks,
}: {
  workbenchSession: WorkbenchSession | null;
  pct: number;
  streaming: boolean;
  subagentBlocks?: Map<string, SubagentBlockState>;
}) {
  const sessionId = workbenchSession?.id ?? null;
  const mode = normalizeHarnessMode(workbenchSession?.agentMode);
  const jobs = useQuery({
    queryKey: ['harness-jobs', sessionId],
    queryFn: () => subagents.listJobs(sessionId!),
    enabled: !!sessionId,
    refetchInterval: streaming ? 4_000 : 12_000,
  });

  const liveWorkers = [...(subagentBlocks?.values() ?? [])].filter(
    (a) => a.status === 'running',
  ).length;
  const activeJob = (jobs.data ?? []).find(
    (j) => j.status === 'running' || j.dirty || j.status === 'failed' || j.status === 'partial',
  );
  const waves = activeJob?.waves ?? [];
  const liveNames = [...(subagentBlocks?.values() ?? [])]
    .filter((a) => a.status === 'running')
    .map((a) => a.workstream?.trim() || '')
    .filter(Boolean);
  const { now: waveNow, total: waveTotal } = resolveActiveWave(
    waves,
    liveNames,
    activeJob?.status,
  );

  const lastExit = workbenchSession?.lastCommand?.exitCode;
  const quiet =
    !streaming &&
    !activeJob &&
    liveWorkers === 0 &&
    mode === 'agent' &&
    lastExit == null;
  if (quiet) return null;

  const tightCtx = pct >= 70;
  const openWorkers = () => addRightDrawerSection('subagents');
  const continueDirty = () => {
    const names = waves.flat().filter(Boolean);
    const name = names[names.length - 1];
    if (!name || !sessionId) return;
    void subagents.continueWorkstream(
      sessionId,
      name,
      'Continue from the last episode.',
    );
  };

  return (
    <div
      className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/40 bg-background/80 px-4 py-1.5 backdrop-blur-md"
      data-testid="chat-run-header"
    >
      <span
        className={cn(
          'text-[11px] font-medium',
          mode === 'orchestrator' ? 'text-violet-300' : 'text-muted-foreground',
        )}
      >
        {MODE_LABEL[mode] ?? 'Agent'}
      </span>
      {waveTotal > 0 ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <button
            type="button"
            onClick={openWorkers}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            Wave {Math.max(1, waveNow)}/{waveTotal}
          </button>
        </>
      ) : null}
      {tightCtx ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-[11px] tabular-nums text-warning">{pct}% ctx</span>
        </>
      ) : null}
      {liveWorkers > 0 ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <button
            type="button"
            onClick={openWorkers}
            className="inline-flex items-center gap-1 text-[11px] text-foreground/80 hover:text-foreground"
          >
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
            {liveWorkers} live
          </button>
        </>
      ) : streaming ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-[11px] text-muted-foreground">Working</span>
        </>
      ) : null}
      {activeJob?.status === 'failed' || activeJob?.status === 'partial' || activeJob?.error ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <button
            type="button"
            onClick={openWorkers}
            className="max-w-[14rem] truncate text-[11px] text-destructive hover:underline"
            title={activeJob.error || activeJob.status}
          >
            {activeJob.error || 'Dispatch failed'}
          </button>
        </>
      ) : null}
      {workbenchSession?.verifierEnforced ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-[11px] text-muted-foreground">Verifier</span>
        </>
      ) : null}
      {activeJob?.dirty ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <button
            type="button"
            onClick={continueDirty}
            className="text-[11px] text-warning hover:underline"
          >
            Needs handoff
          </button>
        </>
      ) : null}
      {lastExit != null ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <span
            className={
              lastExit === 0
                ? 'text-[11px] tabular-nums text-muted-foreground'
                : 'text-[11px] tabular-nums text-destructive'
            }
            title={workbenchSession?.lastCommand?.command || 'Last command'}
          >
            exit {lastExit}
          </span>
        </>
      ) : null}
      {workbenchSession?.lastReceipt?.artifacts?.length ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <span
            className="max-w-[14rem] truncate text-[11px] text-muted-foreground"
            title={workbenchSession.lastReceipt.artifacts.join('\n')}
          >
            {workbenchSession.lastReceipt.artifacts.slice(0, 2).join(' · ')}
          </span>
        </>
      ) : workbenchSession?.lastCommand?.command ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <span className="max-w-[12rem] truncate font-mono text-[11px] text-muted-foreground" title={workbenchSession.lastCommand.command}>
            {workbenchSession.lastCommand.command}
          </span>
        </>
      ) : null}
      {activeJob?.id && waveTotal > 0 && (activeJob.status === 'running' || liveWorkers > 0) ? (
        <>
          <span className="text-muted-foreground/30">·</span>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            title="Stop this wave"
            onClick={() => {
              void subagents.cancelWave(activeJob.id, Math.max(0, waveNow - 1)).then(() => {
                void jobs.refetch();
              });
            }}
          >
            Stop wave
          </button>
        </>
      ) : null}
    </div>
  );
}
