/* In-app terminal sessions, buffer, PTY commands, and external shell open. */

import { api } from '../client';

export interface TerminalSession {
  id: string;
  title?: string;
  cwd?: string;
  command?: string;
  status?: string;
  createdAt?: string;
  cols?: number;
  rows?: number;
  pty?: boolean;
  error?: string | null;
  approvedInteractive?: boolean;
  shell?: string;
}

export interface TerminalApproval {
  requestId: string;
  id?: string;
  type?: string;
  command?: string;
  cwd?: string;
  inputPreview?: string;
  reason?: string;
  status?: string;
  createdAt?: string;
}

export interface TerminalSessionsResponse {
  sessions: TerminalSession[];
  approvals: TerminalApproval[];
}

export function getTerminalSessions(): Promise<TerminalSessionsResponse> {
  return api.get<TerminalSessionsResponse>('/api/terminal/sessions');
}

export function getTerminalBuffer(sessionId: string): Promise<{ buffer: string } & TerminalSession> {
  return api.get<{ buffer: string } & TerminalSession>(
    `/api/terminal/buffer?id=${encodeURIComponent(sessionId)}`,
  );
}

export function createTerminalSession(params?: {
  cwd?: string;
  title?: string;
  approvedInteractive?: boolean;
  cols?: number;
  rows?: number;
}): Promise<TerminalSession & { error?: string | null }> {
  return api.post<TerminalSession & { error?: string | null }>('/api/terminal/sessions', {
    approvedInteractive: true,
    ...(params || {}),
  });
}

/** Open a real OS terminal window (Windows Terminal / PowerShell / Terminal.app). */
export function openExternalTerminal(cwd?: string): Promise<{ ok: boolean; via?: string; cwd?: string }> {
  return api.post('/api/terminal/open-external', { cwd: cwd || '' });
}

export function submitTerminalCommand(sessionId: string, command: string): Promise<unknown> {
  return api.post('/api/terminal/command', { sessionId, command });
}

export function resizeTerminalSession(sessionId: string, cols: number, rows: number): Promise<unknown> {
  return api.post('/api/terminal/resize', { sessionId, cols, rows });
}

export function approveTerminalRequest(requestId: string, approve = true): Promise<unknown> {
  return api.post('/api/terminal/approve', { requestId, approve });
}

export function deleteTerminalSession(id: string): Promise<unknown> {
  return api.delete(`/api/terminal/sessions/${encodeURIComponent(id)}`);
}
