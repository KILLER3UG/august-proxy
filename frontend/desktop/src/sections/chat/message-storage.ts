/* ── Chat message / draft persistence ─────────────────────────────────── */
/* LocalStorage adapters for session transcripts and composer drafts.     */

import type { ChatMessage } from '@/types/chat';

const MESSAGES_STORAGE_PREFIX = 'chat_messages_';
const COMPOSER_DRAFT_PREFIX = 'august_composer_draft_';

export const messagesStorageKey = (sessionId: string | null) =>
  sessionId ? `${MESSAGES_STORAGE_PREFIX}${sessionId}` : null;

export const composerDraftStorageKey = (sessionId: string | null) =>
  sessionId ? `${COMPOSER_DRAFT_PREFIX}${sessionId}` : null;

export type DemoThreadBuilder = (sessionId: string | null) => ChatMessage[];

export function loadMessagesForSession(
  sessionId: string | null,
  buildDemo: DemoThreadBuilder,
): ChatMessage[] {
  const key = messagesStorageKey(sessionId);
  if (!key) return buildDemo(sessionId);

  try {
    const saved = localStorage.getItem(key);
    if (saved) return JSON.parse(saved) as ChatMessage[];
  } catch {
    /* ignore parse errors */
  }

  return buildDemo(sessionId);
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
    /* ignore */
  }
}
