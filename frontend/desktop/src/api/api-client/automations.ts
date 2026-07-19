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
