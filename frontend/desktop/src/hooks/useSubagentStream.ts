/* ── Subagent Stream Hook ────────────────────────────────────────────── */
/* React hook wrapping subscribeToSubagentEvents. Manages a list of active
   sub-agents and their events for a session. */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  subscribeToSubagentEvents,
  listActive,
  type SubagentInfo,
  type SubagentEvent,
} from '@/api/subagents';

interface UseSubagentStreamResult {
  agents: SubagentInfo[];
  events: SubagentEvent[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSubagentStream(sessionId: string | null): UseSubagentStreamResult {
  const [agents, setAgents] = useState<SubagentInfo[]>([]);
  const [events, setEvents] = useState<SubagentEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const active = await listActive(sessionId);
      setAgents(active);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch agents');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    // Initial fetch
    refresh();

    // Subscribe to SSE events
    const unsub = subscribeToSubagentEvents(sessionId, (event: SubagentEvent) => {
      setEvents((prev) => [...prev.slice(-100), event]); // keep last 100

      // Update agent status from events
      if (event.taskId && (event.type === 'subagentCompleted' || event.type === 'subagentDone')) {
        setAgents((prev) =>
          prev.map((a) =>
            a.taskId === event.taskId
              ? { ...a, status: 'completed', finishedAt: Date.now() }
              : a,
          ),
        );
      } else if (event.type === 'subagentStarted' && event.agentId && event.goal) {
        // Capture into locals so TS narrowing on `event.agentId` / `event.goal`
        // survives the closure below (the inline conditional narrowing does
        // not propagate into callback bodies).
        const taskId = event.taskId ?? `task_${Date.now()}`;
        const agentId: string = event.agentId;
        const goal: string = event.goal;
        setAgents((prev) => {
          const next: SubagentInfo[] = [
            ...prev,
            {
              taskId,
              agentId,
              goal,
              status: 'running',
              startedAt: Date.now(),
              elapsed: 0,
            },
          ];
          return next;
        });
      }
    });

    unsubRef.current = unsub;

    return () => {
      unsub();
      unsubRef.current = null;
    };
  }, [sessionId, refresh]);

  return { agents, events, loading, error, refresh };
}
