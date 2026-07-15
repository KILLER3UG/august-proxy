/* ── TeamAgentsStrip — active sub-agents + isolation toggle ───────── */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, GitBranch, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  listWorkbenchSessionAgents,
  setIsolateSubagents,
  type SessionAgentRow,
} from '@/api/workbench';
import { toast } from 'sonner';

export function TeamAgentsStrip({
  workbenchSessionId,
  className,
}: {
  workbenchSessionId: string | null | undefined;
  className?: string;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['session-agents', workbenchSessionId],
    queryFn: () => listWorkbenchSessionAgents(workbenchSessionId!),
    enabled: !!workbenchSessionId,
    refetchInterval: 4_000,
  });

  const isolate = useMutation({
    mutationFn: (enabled: boolean) => setIsolateSubagents(workbenchSessionId!, enabled),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['session-agents', workbenchSessionId] });
      toast.success(
        data.isolateSubagents
          ? 'Sub-agents will use separate git worktrees when possible'
          : 'Sub-agents share the main workspace',
      );
    },
    onError: (e: unknown) =>
      toast.error(`Could not update isolation: ${e instanceof Error ? e.message : String(e)}`),
  });

  if (!workbenchSessionId) return null;

  const agents = (q.data?.agents ?? []).filter(
    (a) => a.status === 'pending' || a.status === 'running',
  );
  const isolateOn = Boolean(q.data?.meta?.isolateSubagents);
  const lastCk = q.data?.meta?.lastCheckpointLabel;

  if (agents.length === 0 && !isolateOn && !lastCk) {
    // Compact idle control: only show isolation chip when user expands? Keep a slim bar.
    return (
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border/50 bg-muted/10 px-3 py-1 text-[11px] text-muted-foreground',
          className,
        )}
      >
        <button
          type="button"
          onClick={() => isolate.mutate(!isolateOn)}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 transition',
            isolateOn
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border/60 hover:bg-muted/40',
          )}
          title="When on, parallel agents try to use separate git worktrees so they do not overwrite each other"
        >
          <GitBranch className="size-3" />
          {isolateOn ? 'Isolated agents' : 'Share workspace'}
        </button>
        {lastCk && (
          <span className="inline-flex items-center gap-1 text-muted-foreground/80">
            <Shield className="size-3" />
            Last save point: {lastCk}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-b border-border/50 bg-muted/15 px-3 py-1.5 text-[11px]',
        className,
      )}
      data-testid="team-agents-strip"
    >
      <button
        type="button"
        onClick={() => isolate.mutate(!isolateOn)}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 transition',
          isolateOn
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'border-border/60 hover:bg-muted/40 text-muted-foreground',
        )}
      >
        <GitBranch className="size-3" />
        {isolateOn ? 'Isolated agents' : 'Share workspace'}
      </button>

      {agents.length > 0 && (
        <>
          <span className="text-muted-foreground font-medium">Team</span>
          {agents.map((a: SessionAgentRow) => (
            <span
              key={a.taskId}
              className="inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-border/50 bg-card px-2 py-0.5"
              title={a.goal}
            >
              {a.status === 'running' || a.status === 'pending' ? (
                <Loader2 className="size-3 animate-spin text-primary" />
              ) : (
                <Bot className="size-3 text-muted-foreground" />
              )}
              <span className="truncate text-foreground/90">{a.goal || a.agentId}</span>
              <span className="text-muted-foreground tabular-nums">
                {a.elapsed != null ? `${Math.round(a.elapsed)}s` : a.status}
              </span>
            </span>
          ))}
        </>
      )}

      {lastCk && (
        <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
          <Shield className="size-3" />
          {lastCk}
        </span>
      )}
    </div>
  );
}
