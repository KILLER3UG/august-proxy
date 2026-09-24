/**
 * Debounced, fire-and-forget sync of the CLIENT-authored transcript to the
 * backend (migration 048).
 *
 * The backend stores one string per message and derives blocks from the model
 * transcript (migration 047). The desktop knows more than that: it renders
 * tool cards with previews, reasoning packs, attachments, inline cards and
 * usage chips, and it alone has the final timeline. This module pushes that
 * timeline so a localStorage wipe does not flatten the conversation.
 *
 * Contract:
 *   * POST /api/sessions/{id}/messages with `clientMessageId` — idempotent
 *     upsert (the server adopts an identical unclaimed row rather than
 *     duplicating the bubble). Used once per message id.
 *   * PATCH /api/sessions/{id}/messages/enrichment with `clientMessageId` —
 *     blocks only, never `content`, so the FTS-indexed text and session
 *     search are untouched. Used for every later update. A 404 means the row
 *     is gone (a workbench rewrite dropped it), so the id is un-claimed and
 *     the next sync POSTs it again.
 *
 * Two rules keep this safe on the send path:
 *   1. It NEVER blocks a send. `scheduleTranscriptSync` returns void, the
 *      timer is detached from the request, and a failure is swallowed — a
 *      lost enrichment must never fail or delay a user's message.
 *   2. It uses the same guards as transcript persistence: a tombstoned
 *      (deleted) session is never written, and a transcript whose backend
 *      history is still loading is not pushed (it would sync a partial view).
 */

import { api, ApiError } from '@/api/client';
import type { ChatMessage } from '@/types/chat';
import { isSessionIdTombstoned } from '@/store/sessions';
import { useSessionStreamStore } from './session-stream-store';

/** Matches the localStorage debounce: one write per burst of edits. */
const SYNC_DEBOUNCE_MS = 1_200;
/** Upper bound on one PATCH body. The server caps at 64 KB; staying under it
 *  client-side keeps a long tool preview from bouncing as a 413. */
const MAX_SYNC_CHARS = 48_000;

/** Structured sibling fields the server allow-lists (mirrors
 *  STRUCTURED_FIELDS in app/services/memory_store/transcript_blocks.py). */
const STRUCTURED_FIELDS = [
  'thinking',
  'thinkingDuration',
  'tools',
  'tool',
  'attachments',
  'todos',
  'usage',
  'turnEnd',
  'changedFiles',
  'clarify',
  'kind',
  'commandId',
  'context',
  'breakdown',
  'queued',
  'usedFallback',
  'editHistory',
] as const satisfies readonly (keyof ChatMessage)[];

const _syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _syncPending = new Map<string, ChatMessage[]>();
/** Client ids already accepted by the server for this session. */
const _syncedIds = new Map<string, Set<string>>();

function canSyncSession(sessionId: string): boolean {
  const history = useSessionStreamStore.getState().bySession[sessionId]?.history;
  return !history || history.status === 'ready';
}

function isClientAuthored(message: ChatMessage): boolean {
  // A restored message is the server's own view of the row. Re-posting it
  // would create a second bubble (its id is the SQLite rowid, not a client
  // id), so only locally authored messages are pushed.
  if (message.remote) return false;
  if (!message.id) return false;
  if (message.role === 'tool') return false;
  return Boolean(message.content?.trim() || message.blocks?.length);
}

function structuredPayload(message: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of STRUCTURED_FIELDS) {
    const value = message[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** Truncate a long block's free text so one preview cannot blow the budget. */
function clipBlocks(blocks: NonNullable<ChatMessage['blocks']>): NonNullable<ChatMessage['blocks']> {
  const perBlock = 4_000;
  return blocks.map((block) => {
    // A `subagent` block nests a whole worker transcript, so clipping only
    // its (absent) top-level `content` would let one verbose worker push the
    // whole message past the server's 64 KB cap — and the sync is dropped
    // wholesale, taking the rest of the timeline with it. Clip the nested
    // blocks on the same budget.
    if (block.type === 'subagent' && block.subagent) {
      const nested = block.subagent.blocks;
      const inner = Array.isArray(nested) ? clipBlocks(nested) : nested;
      return { ...block, subagent: { ...block.subagent, blocks: inner } };
    }
    if (typeof block.content !== 'string' || block.content.length <= perBlock) return block;
    return { ...block, content: `${block.content.slice(0, perBlock)}…` };
  });
}

/** True when the encoded body is small enough to be worth a request. */
function fitsBudget(
  blocks: NonNullable<ChatMessage['blocks']>,
  structured: Record<string, unknown>,
): boolean {
  try {
    return JSON.stringify({ blocks, structured }).length <= MAX_SYNC_CHARS;
  } catch {
    return false; // cyclic / unserializable — nothing useful to send
  }
}

function messagesUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages`;
}

/** Fire one request. Never rejects: sync is best-effort by construction. */
function send(sessionId: string, message: ChatMessage, known: Set<string>): void {
  const blocks = message.blocks?.length ? clipBlocks(message.blocks) : undefined;
  const structured = structuredPayload(message);
  const hasEnrichment = Boolean(blocks) || Object.keys(structured).length > 0;
  if (hasEnrichment && blocks && !fitsBudget(blocks, structured)) return;

  // `clientMessageId` is added per-request below; keeping it out of this
  // object stops a spread from silently overriding it.
  const enrichment = {
    ...(blocks ? { blocks } : {}),
    ...(Object.keys(structured).length ? { structured } : {}),
  };

  const claim = () => known.add(message.id);
  const release = () => known.delete(message.id);

  if (known.has(message.id)) {
    // A plain text bubble with nothing structured has no enrichment to
    // write; POSTing an empty payload would only earn a 400.
    if (!hasEnrichment) return;
    void api
      .patch<{ status: string }>(`${messagesUrl(sessionId)}/enrichment`, {
        clientMessageId: message.id,
        ...enrichment,
      })
      .then(claim)
      .catch((err) => {
        // 404 = the row no longer exists (workbench rewrite, session reset).
        // Drop the claim so the next sync POSTs the message again.
        if (err instanceof ApiError && err.status === 404) release();
      });
    return;
  }

  // Unclaimed: the POST carries the text AND establishes the client id the
  // enrichment endpoint needs. It is an idempotent upsert server-side.
  void api
    .post(messagesUrl(sessionId), {
      role: message.role,
      content: message.content ?? '',
      clientMessageId: message.id,
      ...enrichment,
    })
    .then(claim)
    .catch(() => {
      /* offline / backend restarting — the next debounce retries */
    });
}

function runSync(sessionId: string, messages: ChatMessage[]): void {
  if (isSessionIdTombstoned(sessionId) || !canSyncSession(sessionId)) return;
  const known = _syncedIds.get(sessionId) ?? new Set<string>();
  _syncedIds.set(sessionId, known);
  for (const message of messages) {
    if (isClientAuthored(message)) send(sessionId, message, known);
  }
}

/** Queue a sync for later. Returns immediately — the caller never waits. */
export function scheduleTranscriptSync(sessionId: string, messages: ChatMessage[]): void {
  if (isSessionIdTombstoned(sessionId)) return;
  _syncPending.set(sessionId, messages);
  if (_syncTimers.has(sessionId)) return;
  _syncTimers.set(
    sessionId,
    setTimeout(() => {
      _syncTimers.delete(sessionId);
      const pending = _syncPending.get(sessionId);
      if (!pending) return;
      _syncPending.delete(sessionId);
      if (isSessionIdTombstoned(sessionId)) return;
      runSync(sessionId, pending);
    }, SYNC_DEBOUNCE_MS),
  );
}

/** Flush the pending sync now (stream finalize). Still fire-and-forget. */
export function flushTranscriptSync(sessionId: string, messages?: ChatMessage[]): void {
  const timer = _syncTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    _syncTimers.delete(sessionId);
  }
  // No explicit list: use what the debounce queued, else the live transcript.
  // Finalize is the moment the assistant turn's timeline is complete, and it
  // was never scheduled by the send path — the store is the source of truth.
  const pending =
    messages ??
    _syncPending.get(sessionId) ??
    useSessionStreamStore.getState().bySession[sessionId]?.messages;
  _syncPending.delete(sessionId);
  if (!pending) return;
  if (isSessionIdTombstoned(sessionId)) return;
  runSync(sessionId, pending);
}

/** Drop every trace of a session (deleted chat / LRU eviction). */
export function resetTranscriptSync(sessionId: string): void {
  const timer = _syncTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  _syncTimers.delete(sessionId);
  _syncPending.delete(sessionId);
  _syncedIds.delete(sessionId);
}

/** Test seam: the client ids the server has already accepted. */
export function syncedMessageIds(sessionId: string): string[] {
  return [...(_syncedIds.get(sessionId) ?? [])];
}
