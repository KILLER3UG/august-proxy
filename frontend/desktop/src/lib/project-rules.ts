/* ── Project rules discovery (walk-up) ────────────────────────────────── */
/* Finds AUG.md / CLAUDE.md / AGENTS.md from workspace roots.             */

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
    const res = await fetch(
      `/api/workspace/files?path=${encodeURIComponent(root)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as {
        files?: Array<{ name: string; path: string; isDir?: boolean }>;
      };
      for (const f of data.files ?? []) {
        if (f.isDir) continue;
        const base = f.name || f.path.split(/[/\\]/).pop() || '';
        if (RULE_NAMES.some((n) => n.toLowerCase() === base.toLowerCase())) {
          found.push({ name: base, path: f.path || `${root}/${base}` });
        }
      }
    }
  } catch {
    /* ignore */
  }

  // AUG API context (authoritative for AUG.md)
  try {
    const res = await fetch(
      `/api/aug/context?workspacePath=${encodeURIComponent(root)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as { exists?: boolean; path?: string };
      if (data.exists && data.path) {
        const name = data.path.split(/[/\\]/).pop() || 'AUG.md';
        if (!found.some((x) => x.path === data.path)) {
          found.unshift({ name, path: data.path });
        }
      }
    }
  } catch {
    /* ignore */
  }

  return found;
}
