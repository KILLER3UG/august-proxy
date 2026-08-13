/* ── Subagent API client ─────────────────────────────────────────────── */
/* Typed client for the /api/subagents/* endpoints and SSE streaming. */

import { api } from './client';

export interface WorkItem {
  goal: string;
  agentId?: string;
  restrictedTools?: string[];
  context?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  yieldSchema?: Record<string, unknown>;
  name?: string;
  workstream?: string;
  dependsOn?: string[];
  sourceWorkstreams?: string[];
  acceptanceCriteria?: string;
  stopCondition?: string;
  maxIterations?: number;
}

export interface SpawnRequest {
  workItems: WorkItem[];
  mode: 'auto' | 'proposed' | 'negotiated';
}

export interface SubagentInfo {
  taskId: string;
  agentId: string;
  goal: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial' | 'recovered';
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  elapsed: number;
  workstream?: string;
}

export interface SpawnResult {
  status: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  results?: SubagentInfo[];
  proposalId?: string;
  message?: string;
}

/** List active sub-agents for a session. */
export async function listActive(sessionId?: string): Promise<SubagentInfo[]> {
  const params = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const res = await api.get<{ agents: SubagentInfo[] }>(`/api/subagents/active${params}`);
  return res.agents;
}

/** Spawn one or more sub-agents. Pass `sessionId` to bind the launch to a
 * workbench session so its events stream into that chat's transcript and
 * the right-drawer roster (without it, agents attach to `'default'` and
 * never render anywhere but the Runs history). */
export async function spawn(request: SpawnRequest, sessionId?: string): Promise<SpawnResult> {
  return api.post<SpawnResult>(
    '/api/subagents/spawn',
    request,
    sessionId ? { 'X-Session-Id': sessionId } : undefined,
  );
}

/** Terminate a running sub-agent by task ID. */
export async function terminate(taskId: string): Promise<{ status: string }> {
  return api.post<{ status: string }>(`/api/subagents/${encodeURIComponent(taskId)}/terminate`);
}

/** Terminate every active sub-agent for a session. */
export async function stopAll(sessionId?: string): Promise<{ status: string; stopped: number; total: number }> {
  return api.post<{ status: string; stopped: number; total: number }>(
    '/api/subagents/stop-all',
    sessionId ? { sessionId } : undefined,
  );
}

/** Re-run a finished/failed sub-agent with the same goal + agent role.
 * Returns the NEW task id; events stream into the original session. */
export async function resume(taskId: string): Promise<SpawnResult> {
  return api.post<SpawnResult>(`/api/subagents/${encodeURIComponent(taskId)}/resume`);
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

export interface WorkstreamEpisode {
  seq: number;
  taskId?: string;
  status?: string;
  summary?: string;
  artifacts?: string[];
  next?: string;
  createdAt?: string;
}

export interface WorkstreamRow {
  name: string;
  updatedAt?: string;
  latest?: WorkstreamEpisode | null;
}

export async function listWorkstreams(sessionId: string): Promise<WorkstreamRow[]> {
  const res = await api.get<{ workstreams: WorkstreamRow[] }>(
    `/api/subagents/workstreams?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return res.workstreams ?? [];
}

export async function listWorkstreamEpisodes(
  sessionId: string,
  name: string,
): Promise<WorkstreamEpisode[]> {
  const res = await api.get<{ episodes: WorkstreamEpisode[] }>(
    `/api/subagents/workstreams/${encodeURIComponent(name)}/episodes?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return res.episodes ?? [];
}

/** Queue a follow-up for a running worker's next round. */
export async function steer(taskId: string, message: string): Promise<{ status: string; taskId: string }> {
  return api.post(`/api/subagents/${encodeURIComponent(taskId)}/steer`, { message });
}

/** Spawn a fresh worker on a named workstream (prior episodes injected). */
export async function continueWorkstream(
  sessionId: string,
  name: string,
  message: string,
  agentId = 'general',
): Promise<SpawnResult> {
  return api.post(
    `/api/subagents/workstreams/${encodeURIComponent(name)}/continue`,
    { message, agentId },
    { 'X-Session-Id': sessionId },
  );
}
