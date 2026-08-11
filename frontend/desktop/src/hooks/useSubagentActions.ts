/* ── useSubagentActions ─ stop / stop-all for sub-agent surfaces ──────── */
/* Shared mutations: per-row Stop (terminate one task) and "Stop all"
 * (terminate every active agent for a session). Both invalidate the runs
 * queries so the rosters and the Runs tab stay in sync. */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import * as subagents from '@/api/subagents';

export function useSubagentActions() {
  const qc = useQueryClient();

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['subagent-runs'] });
    void qc.invalidateQueries({ queryKey: ['subagent-active'] });
  };

  const stop = useMutation({
    mutationFn: (taskId: string) => subagents.terminate(taskId),
    onSuccess: () => {
      toast.success('Sub-agent stopped');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Stop failed'),
  });

  const stopAll = useMutation({
    mutationFn: (sessionId?: string) => subagents.stopAll(sessionId),
    onSuccess: (res) => {
      toast.success(
        res.stopped > 0
          ? `Stopped ${res.stopped} sub-agent${res.stopped === 1 ? '' : 's'}`
          : 'No running sub-agents to stop',
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Stop-all failed'),
  });

  return { stop, stopAll };
}
