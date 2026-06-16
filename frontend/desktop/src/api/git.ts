/* ── git-api ─ typed client for /api/git/* ─────────────────────────── */

import { api } from './client';

export interface GitFileStatus {
  path: string;
  status: string;
  added: number;
  removed: number;
}

export interface GitStatus {
  workspace: string | null;
  added: number;
  removed: number;
  files: GitFileStatus[];
  error?: string;
}

export interface GitBranchInfo {
  workspace: string | null;
  current: string | null;
  error?: string;
}

export interface GitBranchList {
  workspace: string | null;
  branches: Array<{ name: string; current: boolean }>;
  error?: string;
}

export interface GitCommitResult {
  workspace: string | null;
  sha: string;
  output: string;
}

export const gitApi = {
  status:   (sessionId?: string) =>
    api.get<GitStatus>(`/api/git/status${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  branch:   (sessionId?: string) =>
    api.get<GitBranchInfo>(`/api/git/branch${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  branches: (sessionId?: string) =>
    api.get<GitBranchList>(`/api/git/branches${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  commit:   (sessionId: string, message: string) =>
    api.post<GitCommitResult>('/api/git/commit', { sessionId, message }),
  checkout: (sessionId: string, branch: string) =>
    api.post<GitCommitResult>('/api/git/checkout', { sessionId, branch }),
};
