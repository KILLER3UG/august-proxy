/* Automation jobs list / run / delete under /api/automations. */

import { api } from '../client';

export interface AutomationJob {
  id: string;
  name?: string;
  type?: string;
  schedule?: string;
  task?: string;
  command?: string;
  cwd?: string;
  agent?: string;
  enabled?: boolean;
  approved?: boolean;
  approvalRequired?: boolean;
  timeoutMs?: number;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastResult?: unknown;
}

export interface AutomationListResponse {
  jobs?: AutomationJob[];
  job?: AutomationJob;
}

export function getAutomations(): Promise<AutomationListResponse> {
  return api.get<AutomationListResponse>('/api/automations');
}

export function runAutomation(id: string, approved = false): Promise<unknown> {
  return api.post('/api/automations/run', { id, approved });
}

export function deleteAutomation(id: string): Promise<{ deleted: boolean }> {
  return api.delete<{ deleted: boolean }>(`/api/automations/${encodeURIComponent(id)}`);
}
