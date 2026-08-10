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

/** Recent chat sessions for the @ picker — from the local sessions store. */
export function fetchConversationMentions(
  sessions: Array<{ id: string; title?: string; workbenchSessionId?: string; model?: string }>,
  query: string,
  excludeId?: string | null,
): MentionItem[] {
  const q = (query || '').toLowerCase();
  const out: MentionItem[] = [];
  for (const s of sessions) {
    if (excludeId && (s.id === excludeId || s.workbenchSessionId === excludeId)) continue;
    const title = (s.title || s.id || '').trim();
    if (!title) continue;
    if (q && !title.toLowerCase().includes(q)) continue;
    out.push({
      kind: 'conversation' as const,
      name: `@chat:${title.slice(0, 32)}`,
      desc: s.model ? `Past conversation · ${s.model}` : 'Past conversation',
      insert: `@chat:${title} `,
    });
    if (out.length >= 8) break;
  }
  return out;
}
