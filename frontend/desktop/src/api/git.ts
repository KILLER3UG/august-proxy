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
  /** True when HEAD is detached (a commit/tag, not a branch) — `current`
   *  then holds the short SHA. */
  detached?: boolean;
  error?: string;
}

export interface GitBranchEntry {
  name: string;
  current: boolean;
  /** Upstream tracking ref (e.g. 'origin/main'), null when untracked. */
  upstream?: string | null;
  /** Commits ahead of / behind the upstream (0 when untracked). */
  ahead?: number;
  behind?: number;
}

export interface GitBranchList {
  workspace: string | null;
  /** Local branches, current first, then alphabetical. */
  branches: GitBranchEntry[];
  detached?: boolean;
  /** Short SHA of HEAD when detached. */
  head?: string;
  error?: string;
}

export interface GitCommitResult {
  workspace: string | null;
  sha: string;
  output: string;
}

export interface GitCheckoutResult {
  workspace: string | null;
  sha?: string;
  output?: string;
  branch: string;
  ok: boolean;
  /** The switch was blocked by uncommitted changes — offer leave/transfer. */
  dirty?: boolean;
  files?: string[];
  error?: string;
  /** leave/transfer outcome: changes were stashed / brought across. */
  stashed?: boolean;
  carried?: boolean;
  warning?: string;
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
  commit: (sessionId: string, message: string, repoPath?: string, all = false) =>
    api.post<GitCommitResult>('/api/git/commit', {
      sessionId,
      message,
      ...(repoPath ? { repoPath } : {}),
      all,
    }),
  checkout: (
    sessionId: string | undefined,
    branch: string,
    repoPath?: string,
    create = false,
    strategy?: 'leave' | 'transfer',
  ) =>
    api.post<GitCheckoutResult>('/api/git/checkout', {
      sessionId: sessionId || '',
      branch,
      create,
      ...(repoPath ? { repoPath } : {}),
      ...(strategy ? { strategy } : {}),
    }),
  push: (sessionId?: string, repoPath?: string) => {
    const qs = gitQuery(sessionId, repoPath);
    return api.post<GitCommandResult>(`/api/git/push${qs}`, {});
  },
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
