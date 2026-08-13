/* ── useSubagentActions ─ stop / stop-all for sub-agent surfaces ──────── */
/* Shared mutations: per-row Stop (terminate one task) and "Stop all"
 * (terminate every active agent for a session). Both invalidate the runs
 * queries so the rosters and the Runs tab stay in sync. Uses the app's
 * exported queryClient (not useQueryClient) so components render in tests
 * and previews without a QueryClientProvider. */

import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import * as subagents from '@/api/subagents';
import { queryClient } from '@/query-client';

export function useSubagentActions() {
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['subagent-runs'] });
    void queryClient.invalidateQueries({ queryKey: ['subagent-active'] });
    void queryClient.invalidateQueries({ queryKey: ['workstreams'] });
    void queryClient.invalidateQueries({ queryKey: ['session-agents'] });
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

  const steer = useMutation({
    mutationFn: ({ taskId, message }: { taskId: string; message: string }) =>
      subagents.steer(taskId, message),
    onSuccess: () => {
      toast.success('Steering queued for the worker’s next round');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Steer failed'),
  });

  const continueStream = useMutation({
    mutationFn: ({
      sessionId,
      name,
      message,
    }: {
      sessionId: string;
      name: string;
      message: string;
    }) => subagents.continueWorkstream(sessionId, name, message),
    onSuccess: () => {
      toast.success('Continuing workstream');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Continue failed'),
  });

  return { stop, stopAll, steer, continueStream };
}
