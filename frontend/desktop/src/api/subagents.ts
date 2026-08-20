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
  skills?: string[];
}

export interface SpawnRequest {
  workItems: WorkItem[];
  mode: 'auto' | 'proposed' | 'negotiated';
}

export interface SubagentInfo {
  taskId: string;
  agentId: string;
  goal: string;
  status: 'pending' | 'queued' | 'running' | 'stalling' | 'completed' | 'failed' | 'cancelled' | 'partial' | 'recovered';
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  elapsed: number;
  workstream?: string;
  lastActivityAt?: number;
  apiCalls?: number;
  iterations?: number;
  queuePosition?: number;
  queueTotal?: number;
  rawStatus?: string;
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
  skills?: string[];
  unmet?: string;
  criteriaMet?: boolean;
  autoHop?: boolean;
}

export interface WorkstreamRow {
  name: string;
  updatedAt?: string;
  latest?: WorkstreamEpisode | null;
  dirty?: boolean;
  specialist?: HarnessSpecialist | null;
  attention?: 'working' | 'needs' | 'unread' | 'idle' | string;
  unread?: boolean;
}

export interface HarnessSpecialist {
  id: string;
  sessionId?: string;
  name: string;
  workstream?: string;
  agentId?: string;
  skills?: string[];
  model?: string;
  acceptance?: string;
  restrictedTools?: string[];
  autonomy?: 'ask' | 'on_fail' | 'silent' | string;
  workspacePath?: string;
  createdAt?: string;
}

export interface HarnessRoutine {
  id: string;
  sessionId?: string;
  name: string;
  workstream: string;
  goal?: string;
  skills?: string[];
  agentId?: string;
  specialistId?: string;
  sourceSeq?: number;
  schedule?: string;
  paused?: boolean;
  lastRun?: string;
  createdAt?: string;
}

export interface HarnessDigest {
  running?: number;
  dirtyJobs?: number;
  unread?: number;
  needsCount?: number;
  workingCount?: number;
  unattended?: boolean;
  needsHandoff?: Array<{
    workstream: string;
    status?: string;
    next?: string;
    summary?: string;
  }>;
  specialists?: HarnessSpecialist[];
  routines?: HarnessRoutine[];
}

export async function getDigest(sessionId: string, workspacePath?: string): Promise<HarnessDigest> {
  const qs = new URLSearchParams({ sessionId });
  if (workspacePath) qs.set('workspace', workspacePath);
  return api.get(`/api/subagents/digest?${qs.toString()}`);
}

export interface NeedsAttentionRow {
  sessionId: string;
  needs: number;
  working: number;
}

/** Per-session workstream attention counts across all sessions (sidebar
 *  "needs handoff" dots). One request for the whole session list. */
export async function getNeedsAttention(): Promise<NeedsAttentionRow[]> {
  const res = await api.get<{ sessions: NeedsAttentionRow[] }>('/api/subagents/needs-attention');
  return res.sessions ?? [];
}

export async function listSpecialists(sessionId: string): Promise<HarnessSpecialist[]> {
  const res = await api.get<{ specialists: HarnessSpecialist[] }>(
    `/api/subagents/specialists?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return res.specialists ?? [];
}

export async function upsertSpecialist(
  sessionId: string,
  body: Partial<HarnessSpecialist> & { name: string },
): Promise<HarnessSpecialist> {
  return api.post('/api/subagents/specialists', body, {
    'X-Session-Id': sessionId,
    ...(body.workspacePath ? { 'X-Workspace-Path': body.workspacePath } : {}),
  });
}

export async function setSpecialistAutonomy(
  specialistId: string,
  autonomy: string,
): Promise<HarnessSpecialist> {
  return api.post(`/api/subagents/specialists/${encodeURIComponent(specialistId)}/autonomy`, {
    autonomy,
  });
}

export async function listRoutines(sessionId: string): Promise<HarnessRoutine[]> {
  const res = await api.get<{ routines: HarnessRoutine[] }>(
    `/api/subagents/routines?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return res.routines ?? [];
}

export async function saveRoutineFromEpisode(
  sessionId: string,
  workstream: string,
  seq?: number,
): Promise<HarnessRoutine> {
  return api.post(
    '/api/subagents/routines',
    { workstream, seq },
    { 'X-Session-Id': sessionId },
  );
}

export async function runRoutine(sessionId: string, routineId: string): Promise<SpawnResult> {
  return api.post(
    `/api/subagents/routines/${encodeURIComponent(routineId)}/run`,
    {},
    { 'X-Session-Id': sessionId },
  );
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

export interface HarnessJob {
  id: string;
  sessionId: string;
  status: string;
  dirty?: boolean;
  error?: string;
  waves?: string[][];
  taskIds?: string[];
  outcomes?: Record<string, { status?: string; error?: string }>;
  createdAt?: string;
  finishedAt?: string;
}

export async function listJobs(sessionId: string): Promise<HarnessJob[]> {
  const res = await api.get<{ jobs: HarnessJob[] }>(
    `/api/subagents/jobs?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return res.jobs ?? [];
}

export async function cancelJob(jobId: string): Promise<{ status: string; jobId?: string; stopped?: number }> {
  return api.post(`/api/subagents/jobs/${encodeURIComponent(jobId)}/cancel`);
}

export async function markWorkstreamRead(sessionId: string, name: string): Promise<void> {
  await api.post(
    `/api/subagents/workstreams/${encodeURIComponent(name)}/read?sessionId=${encodeURIComponent(sessionId)}`,
    {},
    { 'X-Session-Id': sessionId },
  );
}

export async function saveSkillFromEpisode(
  sessionId: string,
  workstream: string,
  seq?: number,
): Promise<{ name?: string }> {
  return api.post(
    `/api/subagents/workstreams/${encodeURIComponent(workstream)}/save-skill`,
    { seq },
    { 'X-Session-Id': sessionId },
  );
}

export interface SkillPreview {
  name: string;
  slug: string;
  description: string;
  body: string;
  trigger: string;
  category: string;
  createdBy: string;
  seq: number;
}

export async function previewSkillFromEpisode(
  sessionId: string,
  workstream: string,
  seq?: number,
): Promise<SkillPreview> {
  const qSeq = seq !== undefined ? `&seq=${encodeURIComponent(seq)}` : '';
  return api.get<SkillPreview>(
    `/api/subagents/workstreams/${encodeURIComponent(workstream)}/skill-preview?sessionId=${encodeURIComponent(sessionId)}${qSeq}`,
  );
}

export async function scheduleRoutine(
  routineId: string,
  schedule: string,
  paused?: boolean,
): Promise<HarnessRoutine> {
  return api.post(`/api/subagents/routines/${encodeURIComponent(routineId)}/schedule`, {
    schedule,
    paused,
  });
}

export async function searchHarness(sessionId: string, q: string): Promise<{ hits?: Array<Record<string, unknown>> }> {
  return api.get(
    `/api/subagents/search?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(q)}`,
  );
}

export async function cancelWave(
  jobId: string,
  waveIndex: number,
): Promise<{ status: string; jobId?: string; stopped?: number }> {
  return api.post(
    `/api/subagents/jobs/${encodeURIComponent(jobId)}/cancel-wave?wave=${waveIndex}`,
  );
}
