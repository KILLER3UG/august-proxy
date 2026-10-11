/* ── Chat message / draft persistence ─────────────────────────────────── */
/* LocalStorage adapters for session transcripts and composer drafts.     */

import type { ChatMessage } from '@/types/chat';
import { normalizeSystemBlocks } from '@/sections/chat/stream/append-block-event';

/* v2. Every cache written under v1 predates the transcript restore merging a
 * tool-result row into its assistant `toolCall` block, and such a cache cannot
 * be repaired in place: the v1 shape has NO join key at all. The standalone row
 * carries `tool` = {name, result, status, tone} and nothing else — no
 * `toolUseId` (the field did not exist), no id inside `tool` — while the block
 * is keyed `call_…`. So a v1 cache that still holds the duplicated rows is
 * unmatchable, and `dropDuplicatedToolRows` — which only works from v2 onward,
 * where `toolUseId` is carried through `STRUCTURED_FIELDS` — cannot help it.
 *
 * That matters because a warm reload NEVER fetches: `hydrate` marks history
 * `status:'ready'` whenever a cache exists and `ensureSessionHistory` returns
 * early on `'ready'`. The v1 cache is served straight from localStorage, and
 * `persistMessagesDebounced` re-writes it on every change, so it never
 * self-heals. The v1 prefix is exactly the population reporting the duplicate
 * rows.
 *
 * Renaming the key makes every v1 cache read as absent once, so each session
 * refetches, merges by id, and repersists correctly under v2. Five production
 * sites used to hardcode `chat_messages_` (store/sessions.ts x4,
 * store/sessions/helpers.ts x1); they now go through `messagesStorageKey` /
 * `legacyMessagesStorageKey` so the rename cannot desync them. Old keys are
 * left in place rather than deleted — they are transcript data, and
 * `evictOldestTranscripts` already prunes the `chat_messages_*` family on
 * quota. */
const MESSAGES_STORAGE_PREFIX = 'chat_messages_v2_';
/** Pre-v2 keys, so a session delete/archive still clears the old transcript. */
const LEGACY_MESSAGES_STORAGE_PREFIX = 'chat_messages_';
const COMPOSER_DRAFT_PREFIX = 'august_composer_draft_';

export const messagesStorageKey = (sessionId: string | null) =>
  sessionId ? `${MESSAGES_STORAGE_PREFIX}${sessionId}` : null;

/** The pre-v2 key for a session. Read is never valid — only deletion. */
export const legacyMessagesStorageKey = (sessionId: string | null) =>
  sessionId ? `${LEGACY_MESSAGES_STORAGE_PREFIX}${sessionId}` : null;

export const composerDraftStorageKey = (sessionId: string | null) =>
  sessionId ? `${COMPOSER_DRAFT_PREFIX}${sessionId}` : null;

/** A saved [] is an intentional empty transcript, not missing history. */
export function hasStoredMessages(sessionId: string): boolean {
  try {
    const saved = localStorage.getItem(messagesStorageKey(sessionId)!);
    return saved !== null && Array.isArray(JSON.parse(saved));
  } catch {
    return false;
  }
}

/** Drop a cached `role:'tool'` row whose tool is already rendered by an
 * assistant message's `blocks`.
 *
 * This is the same rule `mapRemoteMessages` applies on a server fetch, run
 * again on the LOCAL CACHE — and it has to run there, because a warm reload
 * never fetches. `hydrate` marks history `status:'ready'` whenever a cache
 * exists and `ensureSessionHistory` returns early on `'ready'`, so the cached
 * transcript is served straight from localStorage. Every cache written before
 * the merge fix still holds the duplicated rows (30 of them, 26 KB, on one real
 * session), and without this the fix would only help a session whose cache had
 * already been cleared — i.e. not the people reporting the bug.
 *
 * The rows are dropped only when an assistant block with the same tool id
 * exists, and the row's outcome is folded into that block first, so nothing is
 * lost — exactly the merge the live reducer performs. */
function dropDuplicatedToolRows(messages: ChatMessage[]): ChatMessage[] {
  /* ONLY assistant blocks count as "already rendered".
   *
   * The first version collected block ids from EVERY message and dropped any
   * tool row whose id appeared in that set. `derive_blocks` gives every
   * standalone `role:'tool'` row its OWN `toolCall` block, id'd by
   * `tool_use_id` (`transcript_blocks.py`, the `role == 'tool'` branch) — so the
   * row's own id landed in the set, the merge below (which only walks
   * `role === 'assistant'`) merged nothing, and the filter deleted the row
   * anyway. For any pre-047 transcript — assistant carrying no matching
   * toolCall block, which is exactly the population the v2 rename targets —
   * that is silent, permanent loss of the tool output, and the lossy array is
   * then re-persisted so no refetch ever repairs it.
   *
   * `mapRemoteMessages` has this filter and always did; the cache path lost it. */
  const renderedByAssistant = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.blocks ?? []) {
      if (b?.type !== 'toolCall') continue;
      const id = (b.tool as { id?: unknown } | undefined)?.id ?? b.id;
      if (typeof id === 'string' && id) renderedByAssistant.add(id);
    }
  }
  if (renderedByAssistant.size === 0) return messages;

  /* Index the rows ONCE. The first version called `messages.find` inside the
   * block map, i.e. O(blocks × messages) on the session-open path: measured at
   * 0.1 ms for the 40-message session that motivated this, but 109 ms at 4,000
   * messages and 1.34 s at 8,000/6,000. A Map makes it a single pass.
   *
   * The map holds the CONSUMED ROW OBJECT, not just its tool payload. Keying on
   * the id and filtering on the id loses data whenever two rows share one
   * `toolUseId`: `Map.set` keeps only the last, but the filter then dropped
   * *every* row with that id, so the earlier row's output vanished with nothing
   * left to render it. A retry or self-heal that re-emits a result for the same
   * call produces exactly that shape. Dropping by object identity means at most
   * the one row that was actually merged disappears. */
  const consumedRow = new Map<string, { message: ChatMessage; tool: Record<string, unknown> }>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const id = m.toolUseId;
    const tool = m.tool as unknown as Record<string, unknown> | undefined;
    // A row is only droppable when its id is in BOTH sets — that is the exact
    // condition under which the merge below consumed it. Anything else leaves
    // the row as the only rendering of that call.
    if (typeof id === 'string' && id && tool && renderedByAssistant.has(id)) {
      consumedRow.set(id, { message: m, tool });
    }
  }
  const rowToolById = new Map<string, Record<string, unknown>>();
  for (const [id, v] of consumedRow) rowToolById.set(id, v.tool);
  if (rowToolById.size === 0) return messages;

  const out = messages.map((m) => {
    if (m.role !== 'assistant' || !m.blocks) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) => {
        if (b?.type !== 'toolCall') return b;
        const id = (b.tool as { id?: unknown } | undefined)?.id ?? b.id;
        if (typeof id !== 'string' || !renderedByAssistant.has(id)) return b;
        const rowTool = rowToolById.get(id);
        if (!rowTool) return b;
        const blockTool = b.tool as unknown as Record<string, unknown>;
        return {
          ...b,
          tool: {
            ...blockTool,
            ...rowTool,
            id,
            // `||` not `??`: an Anthropic tool row's name is `''`, and `??`
            // would keep it, leaving the block rendering "Executing Tool".
            name: blockTool.name || rowTool.name || '',
            status: rowTool.status || 'done',
          },
        } as typeof b;
      }),
    };
  });

  // Drop ONLY the exact row object that was merged. Matching on object identity
  // (not on the id) is what keeps a second row sharing a `toolUseId` alive: it
  // was never merged, so it is still the only rendering of that output.
  const merged = new Set<ChatMessage>();
  for (const v of consumedRow.values()) merged.add(v.message);
  return out.filter((m) => !merged.has(m));
}

export function loadMessagesForSession(sessionId: string | null): ChatMessage[] {
  const key = messagesStorageKey(sessionId);
  if (!key) return [];

  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      // Persisted history may carry legacy `thinking`+system:true notice
      // rows — normalize them to `type: 'system'` blocks so the thinking
      // pack renders only model chain-of-thought.
      const messages = JSON.parse(saved) as ChatMessage[];
      return dropDuplicatedToolRows(messages).map((m) =>
        m.blocks ? { ...m, blocks: normalizeSystemBlocks(m.blocks) } : m,
      );
    }
  } catch {
    /* ignore parse errors */
  }

  return [];
}

export function loadComposerDraft(sessionId: string | null): string {
  const key = composerDraftStorageKey(sessionId);
  if (!key) return '';
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

export function persistComposerDraft(sessionId: string | null, value: string): void {
  const key = composerDraftStorageKey(sessionId);
  if (!key) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* localStorage may be full or unavailable */
  }
}

export function clearComposerDraft(sessionId: string | null): void {
  const key = composerDraftStorageKey(sessionId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function persistMessages(sessionId: string | null, value: ChatMessage[]): void {
  const key = messagesStorageKey(sessionId);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // QuotaExceeded (months of full transcripts in `chat_messages_*`) made
    // EVERY localStorage write throw — and one throw inside the send path
    // wedged the send latch, so the desktop app silently stopped sending.
    // Self-heal: drop the oldest, largest transcripts (never the current
    // session) and retry once.
    const freed = evictOldestTranscripts(key);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      console.warn(
        `[message-storage] still over quota after evicting ${freed} transcript(s) — message not persisted`,
      );
    }
  }
}

/** Evict persisted transcripts oldest-first (by key) until total
 *  `chat_messages_*` usage drops under ~2 MB or none remain besides
 *  `keepKey`. Returns how many entries were removed.
 *
 *  BOTH prefixes are swept. Matching only `MESSAGES_STORAGE_PREFIX` would
 *  leave every v1 transcript unevictable — and the rename temporarily doubles
 *  peak usage by holding v1 and v2 side by side. That matters because this
 *  function is the only quota safety valve, and the bug it exists to prevent is
 *  documented in `persistMessages`: a `QuotaExceeded` inside the send path
 *  wedged the send latch, so the app silently stopped sending. A user near the
 *  cap with many v1 sessions would hit exactly that wedge with no way to
 *  reclaim the space. */
export function evictOldestTranscripts(keepKey?: string | null): number {
  const prefixes = [MESSAGES_STORAGE_PREFIX, LEGACY_MESSAGES_STORAGE_PREFIX];
  const entries: Array<{ key: string; size: number }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !prefixes.some((p) => k.startsWith(p)) || k === keepKey) continue;
      const v = localStorage.getItem(k) ?? '';
      entries.push({ key: k, size: k.length + v.length });
    }
  } catch {
    return 0;
  }
  const LIMIT = 2 * 1024 * 1024;
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  /* Evict PRE-v2 keys before v2 ones, then oldest-first within each group.
   *
   * The sort used to be a plain `localeCompare` on the whole key, on the comment
   * "key embeds date/time — oldest first". The rename broke that: `chat_messages_v2_x`
   * sorts BEFORE `chat_messages_wb_x` (`v` < `w`), so every readable, merged v2
   * transcript was evicted first while the unreadable v1 copies it replaced
   * survived. Measured over 4 keys past the 2 MB target: 2 unreadable v1
   * transcripts kept, 1 readable v2 kept.
   *
   * v1 first is also just correct: a v1 key is dead weight the moment the
   * refetch lands, and dropping it is what actually reclaims space for the
   * v2 writes the rename forces. */
  const rank = (k: string) => (k.startsWith(LEGACY_MESSAGES_STORAGE_PREFIX) ? 0 : 1);
  entries.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
  let removed = 0;
  for (const e of entries) {
    if (total <= LIMIT) break;
    try {
      localStorage.removeItem(e.key);
      total -= e.size;
      removed += 1;
    } catch {
      break;
    }
  }
  return removed;
}

