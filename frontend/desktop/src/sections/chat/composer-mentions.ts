/* ── Composer @-mention parsing ───────────────────────────────────────── */

export const COMPOSER_TOOLS = [
  { name: '@web_search', desc: 'Search the web for context' },
  { name: '@read_file', desc: 'Read a local file contents' },
  { name: '@run_command', desc: 'Propose shell command execution' },
  { name: '@fetch_url', desc: 'Fetch web content' },
  { name: '@git', desc: 'Attach current git state (branch, changes, recent commits)' },
] as const;

export type MentionItem = {
  kind: 'skill' | 'tool';
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
