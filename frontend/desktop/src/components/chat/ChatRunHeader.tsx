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
  benchmark: 'Benchmark',
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

  const quiet =
    !streaming &&
    !activeJob &&
    liveWorkers === 0 &&
    mode === 'agent';
  if (quiet) return null;

  const tightCtx = pct >= 70;
  const openWorkers = () => addRightDrawerSection('subagents');

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
    </div>
  );
}
