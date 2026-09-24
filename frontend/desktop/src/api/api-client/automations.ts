/* Automation jobs list / create / patch / run / delete under /api/automations. */

import { api } from '../client';

export interface AutomationRun {
  id: string;
  startedAt?: string;
  finishedAt?: string | null;
  status?: string;
  sessionId?: string | null;
  outputSnippet?: string;
  trigger?: string;
}

export interface AutomationJob {
  id: string;
  name?: string;
  jobType?: string;
  type?: string;
  schedule?: string;
  timezone?: string;
  prompt?: string;
  task?: string;
  command?: string;
  cwd?: string;
  workspacePath?: string;
  model?: string;
  modelProvider?: string;
  provider?: string;
  agentId?: string;
  agent?: string;
  enabled?: boolean;
  paused?: boolean;
  approved?: boolean;
  approvalRequired?: boolean;
  timeoutMs?: number;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastOutput?: string | null;
  lastResult?: unknown;
  sessionId?: string | null;
  runs?: AutomationRun[];
  triggerToken?: string;
  triggerUrlHint?: string;
  url?: string;
  method?: string;
  body?: string;
  /** Explicit opt-in for HTTP jobs targeting localhost/private services. */
  allowLocalhost?: boolean;
  /* Part 19 Phase B (routines): delivery + memory knobs. */
  deliver?: string;
  respond?: boolean;
  continuity?: boolean;
  /** Optional cap on terminal runs; the job auto-disables once reached. */
  maxRuns?: number;
  limitReached?: boolean;
  /** Execution policy the unattended run uses (set by the Automations form). */
  guardMode?: string | null;
  sandboxMode?: string | null;
}

export interface AutomationListResponse {
  jobs?: AutomationJob[];
  job?: AutomationJob;
}

export type AutomationUpsertInput = {
  id?: string;
  name?: string;
  schedule?: string;
  jobType?: string;
  prompt?: string;
  command?: string;
  task?: string;
  cwd?: string;
  workspacePath?: string;
  timezone?: string;
  model?: string;
  modelProvider?: string;
  agentId?: string;
  enabled?: boolean;
  paused?: boolean;
  approvalRequired?: boolean;
  timeoutMs?: number;
  url?: string;
  method?: string;
  body?: string;
  /** Explicit opt-in for HTTP jobs targeting localhost/private services. */
  allowLocalhost?: boolean;
  /* Part 19 Phase B (routines): delivery + memory knobs. */
  deliver?: string;
  respond?: boolean;
  continuity?: boolean;
  /** 0 / omitted = unlimited. */
  maxRuns?: number;
  /** Approval mode the unattended run uses; omitted = the runner's 'ask'. */
  guardMode?: string;
  /** Tool reach for the run; '' / omitted = the harness default. */
  sandboxMode?: string;
};

export function getAutomations(): Promise<AutomationListResponse> {
  return api.get<AutomationListResponse>('/api/automations');
}

export function upsertAutomation(body: AutomationUpsertInput): Promise<AutomationJob> {
  return api.post<AutomationJob>('/api/automations', body);
}

export function patchAutomation(
  id: string,
  body: Partial<AutomationUpsertInput> & { paused?: boolean; enabled?: boolean },
): Promise<AutomationJob> {
  return api.patch<AutomationJob>(`/api/automations/${encodeURIComponent(id)}`, body);
}

export function runAutomation(id: string, approved = false): Promise<unknown> {
  return api.post('/api/automations/run', { id, approved });
}

export function rotateAutomationToken(id: string): Promise<AutomationJob> {
  return api.post<AutomationJob>(`/api/automations/${encodeURIComponent(id)}/rotate-token`, {});
}

export function deleteAutomation(id: string): Promise<{ deleted: boolean }> {
  return api.delete<{ deleted: boolean }>(`/api/automations/${encodeURIComponent(id)}`);
}

/* ── M-11 run ledger + incidents ─────────────────────────────────────────── */

export interface AutomationRunRow {
  id: number;
  jobId: string;
  status: string;
  trigger?: string;
  startedAt?: string;
  finishedAt?: string;
  errorSignature?: string;
  sessionId?: string;
  outputDigest?: string;
}

export interface AutomationIncident {
  jobId: string;
  signature?: string;
  state?: string;
  count?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export function getAutomationRuns(jobId: string): Promise<{ runs: AutomationRunRow[] }> {
  return api.get<{ runs: AutomationRunRow[] }>(
    `/api/automations/${encodeURIComponent(jobId)}/runs`,
  );
}

export function getAutomationIncidents(): Promise<{ incidents: AutomationIncident[] }> {
  return api.get<{ incidents: AutomationIncident[] }>('/api/automations/incidents');
}
