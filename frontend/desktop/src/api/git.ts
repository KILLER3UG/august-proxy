/* ── git-api ─ typed client for /api/git/* ─────────────────────────── */

import { api } from './client';

export interface GitFileStatus {
  path: string;
  status: string;
  added: number;
  removed: number;
}

export interface GitDiffFile extends GitFileStatus {
  diff: string;
}

export interface GitStatus {
  workspace: string | null;
  added: number;
  removed: number;
  files: GitFileStatus[];
  error?: string;
}

export interface GitDiffResult {
  workspace: string | null;
  added: number;
  removed: number;
  files: GitDiffFile[];
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

export interface GitLogResult {
  workspace: string | null;
  /** `git log --oneline` output (one commit per line). */
  log: string;
}

export interface GitCommandResult {
  workspace: string | null;
  output: string;
}

function gitQuery(sessionId?: string, repoPath?: string): string {
  const qs = new URLSearchParams();
  if (sessionId) qs.set('sessionId', sessionId);
  if (repoPath) qs.set('repoPath', repoPath);
  const q = qs.toString();
  return q ? `?${q}` : '';
}

export const gitApi = {
  status:   (sessionId?: string, repoPath?: string) =>
    api.get<GitStatus>(`/api/git/status${gitQuery(sessionId, repoPath)}`),
  diff:     (sessionId?: string, repoPath?: string) =>
    api.get<GitDiffResult>(`/api/git/diff${gitQuery(sessionId, repoPath)}`),
  branch:   (sessionId?: string, repoPath?: string) =>
    api.get<GitBranchInfo>(`/api/git/branch${gitQuery(sessionId, repoPath)}`),
  branches: (sessionId?: string, repoPath?: string) =>
    api.get<GitBranchList>(`/api/git/branches${gitQuery(sessionId, repoPath)}`),
  commit:   (sessionId: string, message: string, repoPath?: string) =>
    api.post<GitCommitResult>('/api/git/commit', {
      sessionId,
      message,
      ...(repoPath ? { repoPath } : {}),
    }),
  checkout: (sessionId: string | undefined, branch: string, repoPath?: string) =>
    api.post<GitCommitResult>('/api/git/checkout', {
      sessionId: sessionId || '',
      branch,
      ...(repoPath ? { repoPath } : {}),
    }),
  log:      (sessionId?: string, count = 10, repoPath?: string) => {
    const qs = new URLSearchParams();
    if (sessionId) qs.set('sessionId', sessionId);
    if (repoPath) qs.set('repoPath', repoPath);
    qs.set('count', String(count));
    return api.get<GitLogResult>(`/api/git/log?${qs.toString()}`);
  },
  /** Run an arbitrary git command (e.g. `['restore', '.']`) in the workspace. */
  command:  (args: string[], sessionId?: string, repoPath?: string) =>
    api.post<GitCommandResult>('/api/git/command', {
      args,
      sessionId: sessionId || '',
      ...(repoPath ? { repoPath } : {}),
    }),
};
