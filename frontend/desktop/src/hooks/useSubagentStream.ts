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
      if (event.task_id && (event.type === 'subagent_completed' || event.type === 'subagent_done')) {
        setAgents((prev) =>
          prev.map((a) =>
            a.task_id === event.task_id
              ? { ...a, status: 'completed', finished_at: Date.now() }
              : a,
          ),
        );
      } else if (event.type === 'subagent_started' && event.agent_id && event.goal) {
        setAgents((prev) => [
          ...prev,
          {
            task_id: event.task_id ?? `task_${Date.now()}`,
            agent_id: event.agent_id,
            goal: event.goal,
            status: 'running',
            started_at: Date.now(),
            elapsed: 0,
          },
        ]);
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
