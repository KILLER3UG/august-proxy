/* ── TeamAgentsStrip — active sub-agents + cancel-all ──── */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, X, ScrollText } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  listWorkbenchSessionAgents,
  cancelAllSessionAgents,
  terminateSessionAgent,
  type SessionAgentRow,
} from '@/api/workbench';
import { toast } from 'sonner';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';

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

  const cancelAll = useMutation({
    mutationFn: () => cancelAllSessionAgents(workbenchSessionId!),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['session-agents', workbenchSessionId] });
      toast.message(
        data.count > 0 ? `Cancelled ${data.count} agent${data.count === 1 ? '' : 's'}` : 'No active agents',
      );
    },
    onError: (e: unknown) =>
      toast.error(`Cancel all failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  if (!workbenchSessionId) return null;

  const agents = (q.data?.agents ?? []).filter(
    (a) => a.status === 'pending' || a.status === 'running',
  );

  // Rough cost signal: elapsed seconds as proxy when real cost isn't on the row
  const totalElapsed = agents.reduce((sum, a) => sum + (a.elapsed ?? 0), 0);

  if (agents.length === 0) return null;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-b border-border/50 bg-muted/15 px-3 py-1.5 text-[11px]',
        className,
      )}
      data-testid="team-agents-strip"
    >
      {agents.length > 0 && (
        <>
          <span className="text-muted-foreground font-medium">
            Team · {agents.length}
            {totalElapsed > 0 ? ` · ~${Math.round(totalElapsed)}s` : ''}
          </span>
          {agents.map((a: SessionAgentRow) => (
            <span
              key={a.taskId}
              className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-border/50 bg-card px-2 py-0.5"
              title={[a.goal, a.error].filter(Boolean).join('\n')}
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
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                title="Cancel agent"
                onClick={() => {
                  void terminateSessionAgent(a.taskId)
                    .then(() => {
                      void qc.invalidateQueries({
                        queryKey: ['session-agents', workbenchSessionId],
                      });
                      toast.message('Agent cancelled');
                    })
                    .catch((e: unknown) =>
                      toast.error(
                        `Cancel failed: ${e instanceof Error ? e.message : String(e)}`,
                      ),
                    );
                }}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-0.5 text-destructive hover:bg-destructive/10"
            disabled={cancelAll.isPending}
            onClick={() => cancelAll.mutate()}
            title="Cancel all running agents"
          >
            {cancelAll.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <X className="size-3" />
            )}
            Cancel all
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-muted-foreground hover:bg-muted/40"
            title="Open Workbench tasks"
            onClick={() => {
              addRightDrawerSection('tasks');
              window.dispatchEvent(new CustomEvent('august-open-right-sidebar'));
            }}
          >
            <ScrollText className="size-3" />
            Logs
          </button>
        </>
      )}
    </div>
  );
}
