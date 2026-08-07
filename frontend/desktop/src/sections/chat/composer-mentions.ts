/* ── Composer @-mention parsing ───────────────────────────────────────── */

import { api } from '@/api/client';

export const COMPOSER_TOOLS = [
  { name: '@web_search', desc: 'Search the web for context' },
  { name: '@read_file', desc: 'Read a local file contents' },
  { name: '@run_command', desc: 'Propose shell command execution' },
  { name: '@fetch_url', desc: 'Fetch web content' },
  { name: '@git', desc: 'Attach current git state (branch, changes, recent commits)' },
] as const;

export type MentionItem = {
  kind: 'skill' | 'tool' | 'mcp' | 'file' | 'conversation';
  name: string;
  desc: string;
  /** Inserted into the composer when picked. */
  insert: string;
};

export function parseAtMention(
  value: string,
  cursor?: number,
): { query: string; start: number } | null {
  const pos = cursor ?? value.length;
  const before = value.slice(0, pos);
  const match = before.match(/(^|[\s])@([\w./-]*)$/);
  if (!match) return null;
  const token = match[2] ?? '';
  const start = before.length - token.length - 1;
  return { query: token, start };
}

/** MCP server tools ("plugins") for the @ picker — from /api/mcp/tools. */
export async function fetchMcpMentions(): Promise<MentionItem[]> {
  try {
    const res = await api.get<{ tools: Array<{ name?: string; description?: string }> }>('/api/mcp/tools');
    const tools = res.tools ?? [];
    return tools
      .filter((t) => t.name)
      .map((t) => ({
        kind: 'mcp' as const,
        name: `@${t.name}`,
        desc: t.description || 'MCP plugin tool',
        insert: `@${t.name} `,
      }));
  } catch {
    return [];
  }
}

/** Workspace files for the @ picker — bounded backend listing. */
export async function fetchFileMentions(
  sessionId: string | null | undefined,
  query: string,
): Promise<MentionItem[]> {
  if (!sessionId) return [];
  const qs = new URLSearchParams();
  qs.set('sessionId', sessionId);
  if (query) qs.set('q', query);
  try {
    const res = await api.get<{ results: string[] }>(`/api/workbench/workspace/files?${qs.toString()}`);
    return (res.results ?? []).slice(0, 12).map((rel) => ({
      kind: 'file' as const,
      name: `@${rel}`,
      desc: 'Workspace file',
      insert: `@${rel} `,
    }));
  } catch {
    return [];
  }
}
