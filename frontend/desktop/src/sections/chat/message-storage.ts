/* ── Chat message / draft persistence ─────────────────────────────────── */
/* LocalStorage adapters for session transcripts and composer drafts.     */

import type { ChatMessage } from '@/types/chat';

const MESSAGES_STORAGE_PREFIX = 'chat_messages_';
const COMPOSER_DRAFT_PREFIX = 'august_composer_draft_';

export const messagesStorageKey = (sessionId: string | null) =>
  sessionId ? `${MESSAGES_STORAGE_PREFIX}${sessionId}` : null;

export const composerDraftStorageKey = (sessionId: string | null) =>
  sessionId ? `${COMPOSER_DRAFT_PREFIX}${sessionId}` : null;

export function loadMessagesForSession(sessionId: string | null): ChatMessage[] {
  const key = messagesStorageKey(sessionId);
  if (!key) return [];

  try {
    const saved = localStorage.getItem(key);
    if (saved) return JSON.parse(saved) as ChatMessage[];
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
 *  `keepKey`. Returns how many entries were removed. */
export function evictOldestTranscripts(keepKey?: string | null): number {
  const prefix = MESSAGES_STORAGE_PREFIX;
  const entries: Array<{ key: string; size: number }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix) || k === keepKey) continue;
      const v = localStorage.getItem(k) ?? '';
      entries.push({ key: k, size: k.length + v.length });
    }
  } catch {
    return 0;
  }
  const LIMIT = 2 * 1024 * 1024;
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  entries.sort((a, b) => a.key.localeCompare(b.key)); // key embeds date/time — oldest first
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

