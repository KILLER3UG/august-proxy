/* Preview session lifecycle and approval under /api/preview. */

import { api } from '../client';

export interface PreviewSession {
  id: string;
  title?: string;
  cwd?: string;
  command?: string;
  status?: string;
  url?: string | null;
  createdAt?: string;
  updatedAt?: string;
  logLength?: number;
}

export interface PreviewApproval {
  requestId: string;
  id?: string;
  type?: string;
  command?: string;
  cwd?: string;
  title?: string;
  reason?: string;
  status?: string;
  createdAt?: string;
}

export interface PreviewSessionsResponse {
  sessions: PreviewSession[];
  approvals: PreviewApproval[];
}

export function getPreviewSessions(): Promise<PreviewSessionsResponse> {
  return api.get<PreviewSessionsResponse>('/api/preview/sessions');
}

export function startPreviewSession(params: {
  command: string;
  cwd?: string;
  title?: string;
  approved?: boolean;
}): Promise<PreviewSession | { status: 'approval_required'; requestId: string; reason: string }> {
  return api.post('/api/preview/sessions', params);
}

export function getPreviewSession(id: string): Promise<{ log: string } & PreviewSession> {
  return api.get<{ log: string } & PreviewSession>(`/api/preview/session/${encodeURIComponent(id)}`);
}

export function stopPreviewSession(id: string): Promise<{ deleted: boolean }> {
  return api.delete(`/api/preview/session/${encodeURIComponent(id)}`);
}

export function approvePreviewRequest(requestId: string, approve = true): Promise<unknown> {
  return api.post('/api/preview/approve', { requestId, approve });
}
