/* ── Project rules discovery (walk-up) ────────────────────────────────── */
/* Finds AUG.md / CLAUDE.md / AGENTS.md from workspace roots.             */

import { api } from '@/api/client';

export type ProjectRulesFile = {
  name: string;
  path: string;
};

const RULE_NAMES = ['AUG.md', 'CLAUDE.md', 'AGENTS.md', 'AUGUST.md'] as const;

/**
 * Probe known rule files under a workspace path via the workspace files API.
 * Best-effort; returns [] offline / on error.
 */
export async function discoverProjectRules(
  workspacePath: string | null | undefined,
): Promise<ProjectRulesFile[]> {
  if (!workspacePath?.trim()) return [];
  const root = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const found: ProjectRulesFile[] = [];

  // Direct children of workspace root
  try {
    const data = await api.get<{
      files?: Array<{ name: string; path: string; isDir?: boolean }>;
    }>(`/api/workspace/files?path=${encodeURIComponent(root)}`);
    for (const f of data.files ?? []) {
      if (f.isDir) continue;
      const base = f.name || f.path.split(/[/\\]/).pop() || '';
      if (RULE_NAMES.some((n) => n.toLowerCase() === base.toLowerCase())) {
        found.push({ name: base, path: f.path || `${root}/${base}` });
      }
    }
  } catch {
    /* ignore */
  }

  // AUG API context (authoritative for AUG.md)
  try {
    const data = await api.get<{ exists?: boolean; path?: string }>(
      `/api/aug/context?workspacePath=${encodeURIComponent(root)}`,
    );
    if (data.exists && data.path) {
      const name = data.path.split(/[/\\]/).pop() || 'AUG.md';
      if (!found.some((x) => x.path === data.path)) {
        found.unshift({ name, path: data.path });
      }
    }
  } catch {
    /* ignore */
  }

  return found;
}
