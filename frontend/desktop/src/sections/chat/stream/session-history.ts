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
import { snapshotsFromMessages } from './subagent-blocks';

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
  // The link between a standalone tool row and its assistant `toolCall` block.
  // It has to survive into the persisted cache or the warm-reload merge below
  // has no key to join on.
  'toolUseId',
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
  // A6 provenance. The backend allow-list carries it
  // (memory_store/transcript_blocks.py STRUCTURED_FIELDS), so a reloaded
  // turn still shows what it had injected instead of silently looking like a
  // turn that injected nothing.
  'provenance',
] as const satisfies readonly (keyof ChatMessage)[];

function readStructured(row: Record<string, unknown>): Partial<ChatMessage> {
  const out: Record<string, unknown> = {};
  for (const key of STRUCTURED_FIELDS) {
    if (row[key] !== undefined && row[key] !== null) out[key] = row[key];
  }
  return out;
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

/** Identity a restored row should carry in the client transcript.
 *
 * Migration 048: a row the desktop authored keeps the client's own message id
 * in `clientMessageId`. Using it as the local `id` is what makes the sync
 * round trip — the next PATCH enrichment lands on the same message, and
 * `reconcileHistory` matches by id instead of by content+timestamp. A row with
 * no client id (server-derived, or written before 048) keeps its SQLite id,
 * so nothing about the legacy restore changes. */
function restoredId(row: Record<string, unknown>, index: number): string {
  const clientId = row.clientMessageId ?? row.client_message_id;
  if (typeof clientId === 'string' && clientId.trim()) return clientId.trim();
  return String(row.id ?? `m_remote_${index}`);
}

function looksLikeJsonPayload(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('[') || trimmed.startsWith('{');
}

export function mapRemoteMessages(remote: unknown[]): ChatMessage[] {
  /* Since migration 047 a turn's tool activity lives in the ASSISTANT
   * message's `blocks` — that is what `AssistantBlockTimeline` renders, under
   * the collapsed "Task completed · N steps" header, with the real tool names.
   *
   * The transcript also still contains the pre-047 shape: one standalone
   * `role:'tool'` row per result, carrying its own `tool` payload. Those are
   * the SAME tool, so rendering both showed every call twice.
   *
   * But the two halves are NOT redundant — they carry DISJOINT payloads, and
   * dropping the row on its own destroys data. Measured on
   * `wb_20260905_022058_f49228`:
   *
   *     assistant toolCall blocks : 30   status 'running', result EMPTY on 30/30
   *     standalone tool rows      : 30   status 'done',    result on 30/30
   *                                          26,195 characters of tool output
   *
   * The backend states the contract itself: `_tool_use_block` in
   * `memory_store/transcript_blocks.py` documents that "status stays 'running'
   * until a tool-result message fills the result in (same by-id merge the live
   * reducer does)". The live reducer performs that merge; this restore path
   * did not, so a restored transcript had 30 permanently-spinning, empty tool
   * rows — and the duplicate bubble was the only place the output survived.
   *
   * So: MERGE each tool row into the assistant block carrying the same id,
   * then drop the row. Same rule as the live reducer, one rendering surface,
   * and no tool left stuck at 'running'.
   *
   * A legacy transcript whose assistant messages carry no blocks keeps its tool
   * rows — there the row is the only rendering. */
  const toolResultById = new Map<string, Record<string, unknown>>();
  for (const raw of remote) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (String(r.role ?? '') !== 'tool') continue;
    const tool = r.tool as Record<string, unknown> | undefined;
    if (!tool) continue;
    const id =
      typeof tool.id === 'string' && tool.id
        ? tool.id
        : typeof r.toolUseId === 'string'
          ? r.toolUseId
          : '';
    // Keep the SOURCE ROW alongside the payload: the drop is decided by which
    // row object the merge actually consumed, not by re-deriving its id.
    if (id) toolResultById.set(id, { ...tool, row: r });
  }

  /* Which tool ids an assistant block already renders. Only a row whose id is
   * in HERE is dropped — a legacy transcript with no assistant blocks keeps
   * every tool row, because there the row is the only rendering. Keying the
   * drop on "this row happens to carry a tool payload" instead would delete
   * the entire legacy shape. */
  const renderedToolIds = new Set<string>();
  /* Rows CONSUMED by the merge, tracked by object identity. The merge keys on
   * `tool.id ?? toolUseId` but the drop used to key on `toolUseId` alone, so a
   * row whose id lives only inside its `tool` payload was MERGED-then-DROPPED
   * under a different key — and a row carrying only snake_case `tool_use_id`
   * matched neither, so the drop fired with no merge at all. Two shapes, both
   * silently lossy. Dropping only the row objects the merge actually consumed
   * removes the whole class. */
  const consumedRows = new Set<object>();
  for (const raw of remote) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (String(r.role ?? '') !== 'assistant' || !Array.isArray(r.blocks)) continue;
    for (const b of r.blocks as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object' || b.type !== 'toolCall') continue;
      const t = b.tool as { id?: unknown } | undefined;
      const id = typeof t?.id === 'string' && t.id ? t.id : typeof b.id === 'string' ? b.id : '';
      if (id) renderedToolIds.add(id);
    }
  }

  const out: ChatMessage[] = [];
  for (const raw of remote) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const role = String(r.role ?? 'user');
    // Fold the result into its assistant block, then let the row fall away.
    let row = r;
    if (role === 'assistant' && Array.isArray(r.blocks)) {
      const merged = (r.blocks as Record<string, unknown>[]).map((b) => {
        if (!b || typeof b !== 'object' || b.type !== 'toolCall') return b;
        const t = b.tool as Record<string, unknown> | undefined;
        const id =
          typeof t?.id === 'string' && t.id ? t.id : typeof b.id === 'string' ? b.id : '';
        const result = id ? toolResultById.get(id) : undefined;
        if (!result) return b;
        consumedRows.add(result.row as object);
        // The block carries the NAME (from the assistant's tool_use) and the
        // row carries the OUTCOME. Keep the name, take status/tone/result/
        // summary from the row — that is the merge the live reducer does.
        return {
          ...b,
          tool: {
            ...t,
            ...result,
            id: id,
            // `??` does not catch `''`, and an Anthropic tool row's name IS `''`
            // — so `t?.name ?? result.name` kept the empty string and the merged
            // block still rendered "Executing Tool" even though the block's own
            // name was present. Fall through on empty, not just nullish.
            name: t?.name || result.name || '',
            status: result.status || t?.status || 'done',
          },
        };
      });
      row = { ...r, blocks: merged };
    }
    /* Drop ONLY a row whose payload was folded into an assistant block.
     *
     * The previous guard re-derived the id (`row.toolUseId ?? tool_use_id`) and
     * asked `renderedToolIds`, which could disagree with the key the merge
     * actually used (`tool.id ?? toolUseId`). Two shapes lost data that way:
     * a row whose id lived only inside `tool.id`, and a row carrying only
     * snake_case `tool_use_id` — the drop fired with no merge at all.
     * `consumedRows` is populated by the merge itself, so it cannot disagree. */
    if (role === 'tool' && consumedRows.has(raw)) continue;
    let content = row.content;
    if (content && typeof content === 'object') {
      const c = content as Record<string, unknown>;
      content = typeof c.content === 'string' ? c.content : JSON.stringify(c);
    }
    const blocks = readBlocks(row);
    const structured = readStructured(row);
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
      id: restoredId(row, out.length),
      // Keep the tool role only when a tool payload rides along —
      // MessageBubble renders role:'tool' through ToolCallCard, which needs it.
      role: isToolRow && structured.tool ? 'tool' : isToolRow ? 'assistant' : role,
      content: text,
      timestamp: String(row.createdAt ?? row.created_at ?? new Date().toISOString()),
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
/** Exported for tests: it is pure, and the merge rule below is load-bearing
 * enough that it should be pinned directly rather than only through a fetch. */
export function reconcileHistory(remote: ChatMessage[], injected: ChatMessage[]): ChatMessage[] {
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
    } else if (message.remote) {
      /* A previously-RESTORED message the server no longer returns: drop it.
       *
       * This branch used to push it unconditionally, which made the client's
       * transcript unable to ever shrink. It is the other half of the
       * duplicated-tool-row bug: `mapRemoteMessages` correctly stopped mapping
       * the standalone tool rows (the assistant's blocks already render them),
       * but the cached copy in localStorage still had all 30, and this re-added
       * every one of them on every load — so fixing the mapping alone changed
       * nothing on screen. Measured: `chat_messages_<session>` was 141 KB and
       * the ten `Executing Tool` bubbles survived the fix exactly.
       *
       * `remote: true` is set by `mapRemoteMessages` and only there, so it is
       * the precise marker for "came from the server once" as opposed to
       * "authored here and not yet persisted". A local message the server has
       * not caught up with still falls through to the push below, which is the
       * case this branch must not break. */
      continue;
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
    // Merge the restored worker timelines with anything already live. A live
    // container always wins: after a reconnect the SSE stream may already be
    // streaming fresh frames for a job whose restored snapshot is the
    // transcript up to the last persisted write. Overwriting the live one
    // with the stored one would visibly rewind the worker's output.
    const restored = snapshotsFromMessages(messages);
    const merged = new Map(restored);
    for (const [jobId, state] of current.subagentBlocks ?? []) {
      merged.set(jobId, state);
    }
    const subagentBlocks = new Map(
      [...merged.entries()].sort(
        (a, b) => (a[1].startedAt || 0) - (b[1].startedAt || 0),
      ),
    );
    updateSessionStreamState(sessionId, () => ({
      messages,
      history: { status: 'ready' },
      subagentBlocks,
    }));
    persistMessages(sessionId, messages);
  }).catch((err) => {
    if (useSessionStreamStore.getState().bySession[sessionId]?.history !== history) return;
    const exhausted =
      (_historyRetryAttempts.get(sessionId) ?? 0) >= HISTORY_RETRY_DELAYS_MS.length;
    updateSessionStreamState(sessionId, () => ({
      history: exhausted
        ? {
            status: 'missing',
            error: err instanceof Error ? err.message : 'Failed to load this conversation.',
          }
        : { status: 'missing' },
    }));
    if (!exhausted) scheduleHistoryRetry(sessionId);
  });
  return history.promise;
}

/** Manual retry from the inline error surface — the bounded retry ladder
 *  has already given up by the time the error renders. */
export function retrySessionHistory(sessionId: string): void {
  cancelHistoryRetry(sessionId);
  _historyRetryAttempts.set(sessionId, 0);
  void ensureSessionHistory(sessionId);
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
