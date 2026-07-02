/* ── Subagent API client ─────────────────────────────────────────────── */
/* Typed client for the /api/subagents/* endpoints and SSE streaming. */

import { api } from './client';

export interface WorkItem {
  goal: string;
  agentId?: string;
  restrictedTools?: string[];
  context?: string;
}

export interface SpawnRequest {
  workItems: WorkItem[];
  mode: 'auto' | 'proposed' | 'negotiated';
}

export interface SubagentInfo {
  task_id: string;
  agent_id: string;
  goal: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'recovered';
  result?: string;
  error?: string;
  started_at: number;
  finished_at?: number;
  elapsed: number;
}

export interface SpawnResult {
  status: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  results?: SubagentInfo[];
  proposal_id?: string;
  message?: string;
}

export interface SubagentEvent {
  type: string;
  task_id?: string;
  agent_id?: string;
  goal?: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Subscribe to sub-agent SSE events for a session.
 * Returns an unsubscribe function.
 */
export function subscribeToSubagentEvents(
  sessionId: string,
  onEvent: (event: SubagentEvent) => void,
): () => void {
  const url = `/api/subagents/stream?sessionId=${encodeURIComponent(sessionId)}`;
  const source = new EventSource(url);

  source.onmessage = (msg: MessageEvent) => {
    try {
      const data = JSON.parse(msg.data) as SubagentEvent;
      onEvent(data);
    } catch {
      // ignore parse errors
    }
  };

  source.onerror = () => {
    // EventSource auto-reconnects
  };

  return () => {
    source.close();
  };
}

/** List active sub-agents for a session. */
export async function listActive(sessionId?: string): Promise<SubagentInfo[]> {
  const params = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const res = await api.get<{ agents: SubagentInfo[] }>(`/api/subagents/active${params}`);
  return res.agents;
}

/** Spawn one or more sub-agents. */
export async function spawn(request: SpawnRequest): Promise<SpawnResult> {
  return api.post<SpawnResult>('/api/subagents/spawn', request);
}

/** Terminate a running sub-agent by task ID. */
export async function terminate(taskId: string): Promise<{ status: string }> {
  return api.post<{ status: string }>(`/api/subagents/${encodeURIComponent(taskId)}/terminate`);
}

/** Approve or reject a proposed sub-agent breakdown. */
export async function proposeBreakdown(
  proposalId: string,
  approved: boolean = true,
): Promise<SpawnResult> {
  return api.post<SpawnResult>('/api/subagents/propose-breakdown', {
    proposalId,
    approved,
  });
}
