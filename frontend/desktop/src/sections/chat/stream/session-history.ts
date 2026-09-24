import { api } from '@/api/client';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import { isSessionIdTombstoned } from '@/store/sessions';
import { normalizeSystemBlocks } from './append-block-event';
import {
  getOrInitSessionStreamState,
  useSessionStreamStore,
  updateSessionStreamState,
  persistMessages,
  type SessionHistoryState,
} from './session-stream-store';

const HISTORY_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];
const _historyRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _historyRetryAttempts = new Map<string, number>();

function clearHistoryRetryTimer(sessionId: string): void {
  const timer = _historyRetryTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  _historyRetryTimers.delete(sessionId);
}

function cancelHistoryRetry(sessionId: string): void {
  clearHistoryRetryTimer(sessionId);
  _historyRetryAttempts.delete(sessionId);
}

function scheduleHistoryRetry(sessionId: string): void {
  if (isSessionIdTombstoned(sessionId)) return;
  const attempts = _historyRetryAttempts.get(sessionId) ?? 0;
  if (attempts >= HISTORY_RETRY_DELAYS_MS.length) return;
  const delay = HISTORY_RETRY_DELAYS_MS[attempts];
  const timer = setTimeout(() => {
    _historyRetryTimers.delete(sessionId);
    const current = useSessionStreamStore.getState().bySession[sessionId];
    if (
      !current ||
      current.history?.status !== 'missing' ||
      isSessionIdTombstoned(sessionId)
    ) {
      cancelHistoryRetry(sessionId);
      return;
    }
    void ensureSessionHistory(sessionId);
  }, delay);
  _historyRetryTimers.set(sessionId, timer);
  _historyRetryAttempts.set(sessionId, attempts + 1);
}

/** Structured fields the backend restores from `messages.blocks_json`
 * (migration 047). Copied onto the ChatMessage as-is when present; a row
 * written before 047 has none of them and falls back to plain text. */
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

function readStructured(row: Record<string, unknown>): Partial<ChatMessage> {
  const out: Record<string, unknown> = {};
  for (const key of STRUCTURED_FIELDS) {
    if (row[key] !== undefined && row[key] !== null) out[key] = row[key];
  }
  return out as Partial<ChatMessage>;
}

function readBlocks(row: Record<string, unknown>): MessageBlock[] | undefined {
  if (!Array.isArray(row.blocks) || row.blocks.length === 0) return undefined;
  // Legacy persisted rows stored harness notices as `thinking` + system:true;
  // the thinking pack now holds model reasoning only.
  return normalizeSystemBlocks(row.blocks as MessageBlock[]);
}

/** Text a user would expect to copy from a restored bubble. Structured rows
 * whose `content` is a serialized block envelope (the pre-047 tool-call
 * shape) fall back to the rendered final output. */
function contentFromBlocks(blocks: MessageBlock[]): string {
  return blocks
    .filter((b) => b.type === 'finalOutput' && typeof b.content === 'string')
    .map((b) => b.content as string)
    .join('\n')
    .trim();
}

function looksLikeJsonPayload(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('[') || trimmed.startsWith('{');
}

export function mapRemoteMessages(remote: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const raw of remote) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const role = String(r.role ?? 'user');
    let content = r.content;
    if (content && typeof content === 'object') {
      const c = content as Record<string, unknown>;
      content = typeof c.content === 'string' ? c.content : JSON.stringify(c);
    }
    const blocks = readBlocks(r);
    const structured = readStructured(r);
    let text = typeof content === 'string' ? content : String(content ?? '');
    // A tool result stored before 047 is a JSON envelope in `content`; with
    // structured blocks present the rendered text is the honest fallback.
    if (blocks && text && looksLikeJsonPayload(text)) {
      const rendered = contentFromBlocks(blocks);
      if (rendered) text = rendered;
    }
    // A message can be meaningful with no text at all (tool call, thinking
    // only, attachment-only) — dropping those is what erased tool cards.
    if (!text.trim() && !blocks && !structured.tool) continue;
    const isToolRow = role === 'tool';
    out.push({
      id: String(r.id ?? `m_remote_${out.length}`),
      // Keep the tool role only when a tool payload rides along —
      // MessageBubble renders role:'tool' through ToolCallCard, which needs it.
      role: isToolRow && structured.tool ? 'tool' : isToolRow ? 'assistant' : role,
      content: text,
      timestamp: String(r.createdAt ?? r.created_at ?? new Date().toISOString()),
      remote: true,
      ...structured,
      ...(blocks ? { blocks } : {}),
    } as ChatMessage);
  }
  return out;
}

function timestamp(value: string): number {
  // SQLite returns UTC without a timezone; queuedAt is ISO UTC.
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`);
}

/** SQLite message IDs differ from queue IDs. Match each queued bubble at
 * most once, in order, and never collapse an older identical user prompt.
 * Keep the queue identity so a replayed SSE event still deduplicates. */
function reconcileHistory(remote: ChatMessage[], injected: ChatMessage[]): ChatMessage[] {
  const merged = [...remote];
  const used = new Set<number>();
  for (const message of injected) {
    let index = merged.findIndex((m, i) => !used.has(i) && m.id === message.id);
    if (index < 0 && message.queued) {
      const queuedAt = timestamp(message.timestamp);
      index = merged.findIndex((m, i) =>
        !used.has(i) && i < remote.length && m.role === 'user' && m.content === message.content &&
        Number.isFinite(queuedAt) && timestamp(m.timestamp) >= Math.floor(queuedAt / 1000) * 1000,
      );
    }
    if (index >= 0) {
      merged[index] = message;
      used.add(index);
    } else {
      used.add(merged.length);
      merged.push(message);
    }
  }
  return merged;
}

/** One request per session, shared by StrictMode mounts and idle injection.
 * Completion targets the owning store entry, never a component's stale setter.
 * Failed requests retry with bounded idle backoff; ordinary transcript writes
 * replace history identity and veto late responses. */
export function ensureSessionHistory(sessionId: string): Promise<void> {
  const state = getOrInitSessionStreamState(sessionId);
  if (state.history?.status === 'ready') return Promise.resolve();
  if (state.history?.promise) return state.history.promise;
  clearHistoryRetryTimer(sessionId);
  const history: SessionHistoryState = { status: 'loading' };
  updateSessionStreamState(sessionId, () => ({ history }));
  history.promise = api.get<{ messages: unknown[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  ).then((res) => {
    // Do not re-initialize deleted or LRU-evicted sessions on completion.
    const current = useSessionStreamStore.getState().bySession[sessionId];
    if (current?.history !== history) return;
    cancelHistoryRetry(sessionId);
    const messages = reconcileHistory(
      mapRemoteMessages(Array.isArray(res?.messages) ? res.messages : []),
      current.messages,
    );
    updateSessionStreamState(sessionId, () => ({ messages, history: { status: 'ready' } }));
    persistMessages(sessionId, messages);
  }).catch(() => {
    if (useSessionStreamStore.getState().bySession[sessionId]?.history !== history) return;
    updateSessionStreamState(sessionId, () => ({ history: { status: 'missing' } }));
    scheduleHistoryRetry(sessionId);
  });
  return history.promise;
}

export function injectSessionMessage(sessionId: string, injected: ChatMessage): void {
  // Init from storage before writing anything. Missing backend history stays
  // loading even though the injected bubble makes the transcript nonempty.
  void ensureSessionHistory(sessionId);
  updateSessionStreamState(
    sessionId,
    (prev) => {
      if (prev.messages.some((m) => m.id === injected.id)) return {};
      const messages = [...prev.messages, injected];
      // Never persist an injected-only partial transcript over missing history.
      if (prev.history?.status === 'ready') persistMessages(sessionId, messages);
      return { messages, history: prev.history };
    },
    { transcriptUpdate: 'stream' },
  );
}
