/* ── Composer @-mention parsing ───────────────────────────────────────── */

import { api } from '@/api/client';
import { listBots, type Bot } from '@/api/api-client/bots';

export const COMPOSER_TOOLS = [
  { name: '@web_search', desc: 'Search the web for context' },
  { name: '@read_file', desc: 'Read a local file contents' },
  { name: '@run_command', desc: 'Propose shell command execution' },
  { name: '@fetch_url', desc: 'Fetch web content' },
  { name: '@git', desc: 'Attach current git state (branch, changes, recent commits)' },
] as const;

export type MentionItem = {
  kind: 'skill' | 'tool' | 'mcp' | 'file' | 'conversation' | 'lane' | 'routine' | 'bot';
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

/** Named workstreams and routines for the @ picker. */
export async function fetchHarnessMentions(
  workbenchSessionId: string | null | undefined,
  query: string,
): Promise<MentionItem[]> {
  if (!workbenchSessionId) return [];
  const q = (query || '').toLowerCase();
  try {
    const { listWorkstreams, getDigest } = await import('@/api/subagents');
    const [streams, digest] = await Promise.all([
      listWorkstreams(workbenchSessionId),
      getDigest(workbenchSessionId),
    ]);
    const out: MentionItem[] = [];
    for (const ws of streams) {
      const name = ws.name || '';
      if (!name) continue;
      if (q && !name.toLowerCase().includes(q) && !'lane'.includes(q)) continue;
      out.push({
        kind: 'lane',
        name: `@lane:${name}`,
        desc: ws.latest?.next || ws.latest?.summary || 'Workstream',
        insert: `@lane:${name} `,
      });
    }
    for (const rtn of digest.routines ?? []) {
      const label = rtn.name || rtn.id;
      if (q && !label.toLowerCase().includes(q) && !'routine'.includes(q)) continue;
      out.push({
        kind: 'routine',
        name: `@routine:${rtn.id}`,
        desc: rtn.goal || rtn.workstream || 'Routine',
        insert: `@routine:${rtn.id} `,
      });
    }
    return out.slice(0, 16);
  } catch {
    return [];
  }
}

/* ── Bot Mode @-mention middleware (Phase C, ruling OQ8) ──────────────── */
/* Annotation ONLY — never a delivery. Typing `@bot` in ANY chat resolves the
 * handle against the live roster and appends an identification note to the
 * OUTGOING text; the current agent decides whether to call message_agent.
 * Unknown handles and emails pass through untouched (text never rewritten). */

export type ResolvedBotMention = { handle: string; name: string; title: string };

/** Resolve `@handles` in `text` against the roster (name, display title,
 *  no-space forms). Emails / unknown handles are ignored (pass through). */
export function resolveBotMentions(text: string, bots: Bot[]): ResolvedBotMention[] {
  if (!text || !bots.length) return [];
  const byKey = new Map<string, Bot>();
  for (const b of bots) {
    if (b.name) byKey.set(b.name.toLowerCase(), b);
    const title = (b.uiMeta?.title || '').toLowerCase();
    if (title) byKey.set(title.replace(/\s+/g, ''), b);
    if (b.name) byKey.set(b.name.toLowerCase().replace(/\s+/g, ''), b);
  }
  const seen = new Set<string>();
  const out: ResolvedBotMention[] = [];
  for (const m of text.matchAll(/(^|[\s(])@([\w.-]+)/g)) {
    const handle = (m[2] || '').toLowerCase();
    // The capture class `[\w.-]+` can never contain '@', so an email like
    // a@b.com only ever yields the `b` segment here — unknown handles simply
    // miss the roster lookup below and pass through untouched.
    if (!handle) continue;
    const bot = byKey.get(handle);
    if (!bot) continue;
    if (seen.has(bot.id)) continue;
    seen.add(bot.id);
    out.push({ handle: bot.name, name: bot.name, title: bot.uiMeta?.title || bot.name });
  }
  return out;
}

/** The identification note (mirrors the backend protocol text). '' when
 *  nothing resolved, so the caller leaves the user's text untouched. */
export function botMentionNote(resolved: ResolvedBotMention[]): string {
  if (!resolved.length) return '';
  const parts = resolved.map((r) => `@${r.handle} = agent profile "${r.name}" ("${r.title}")`);
  return (
    '[@mentions resolved from the Bot Mode roster — the user is referring to: ' +
    `${parts.join('; ')}. If they want one of these agents contacted, compose your own ` +
    'message and send it with the message_agent tool; never forward the user\'s text ' +
    'verbatim. If this session has no message_agent tool, agent messaging is unavailable ' +
    'here — say so.]'
  );
}

/** Append the note to the outgoing text (request-only; the displayed bubble
 *  keeps the clean typed text). Returns `text` unchanged when nothing resolves. */
export function annotateBotMentions(text: string, bots: Bot[]): string {
  const note = botMentionNote(resolveBotMentions(text, bots));
  return note ? `${text}\n\n${note}` : text;
}

/** Bot roster for the @ picker. Reads through `getBotRoster` so the picker
 *  and the send-path annotator share one short-lived cache (no extra round
 *  trip per keystroke). */
export async function fetchBotMentions(query: string): Promise<MentionItem[]> {
  const q = (query || '').toLowerCase();
  const bots = await getBotRoster();
  return bots
    .filter((b) => b.name && !b.uiMeta?.hidden)
    .filter((b) => !q || b.name.toLowerCase().includes(q) || (b.uiMeta?.title || '').toLowerCase().includes(q))
    .slice(0, 12)
    .map((b) => ({
      kind: 'bot' as const,
      name: `@${b.name}`,
      desc: b.uiMeta?.title && b.uiMeta.title !== b.name ? b.uiMeta.title : b.description || 'Bot',
      insert: `@${b.name} `,
    }));
}

// Short-lived roster cache so the send path annotates without a per-send
// round-trip (mentions are addressed to a stable roster within a session).
let _rosterCache: { at: number; bots: Bot[] } | null = null;
const _ROSTER_TTL_MS = 30_000;
export async function getBotRoster(): Promise<Bot[]> {
  const now = Date.now();
  if (_rosterCache && now - _rosterCache.at < _ROSTER_TTL_MS) return _rosterCache.bots;
  try {
    const { bots } = await listBots();
    _rosterCache = { at: now, bots };
    return bots;
  } catch {
    return _rosterCache?.bots ?? [];
  }
}
