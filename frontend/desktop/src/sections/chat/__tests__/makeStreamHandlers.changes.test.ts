/* ── makeStreamHandlers: changedFiles derivation + retry rollback ───────
 * Phase 3.1: the backend never emits a `session` SSE event, so the old
 * mutation-count gate (latestMutationCount > beforeMutationCount) was dead
 * and message.changedFiles never populated → ChangesCard never rendered.
 * These tests drive REAL event shapes (toolUse/toolResult/text/done, no
 * `session` frame) and assert the git-diff fetch now keys off edit-class
 * tool results.
 *
 * Phase 3.2: `retrying` fires inside the per-round retry loop, so it must
 * roll back ONLY the failed attempt's partial stream — not every prior
 * round's committed prose.
 *
 * turn_end: the terminal stop diagnostic must land on the assistant message
 * and survive finalize()'s message rebuild (the badge renders post-stream). */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// finalize() reaches for chime / OS-notify / preferences / notification /
// arena / debate side effects. Stub them so the handler runs headless.
vi.mock('@/lib/chat-chime', () => ({ playReceiveChime: vi.fn() }));
vi.mock('@/lib/os-notify', () => ({
  OsNotifyService: { notifyDirect: vi.fn(async () => undefined) },
}));
vi.mock('@/lib/preferences', () => ({
  usePreferencesStore: { getState: () => ({ notifyResponseComplete: false }) },
}));
vi.mock('@/store/notifications', () => ({ pushNotification: vi.fn() }));
vi.mock('../arena/arena-store', () => ({
  useArenaStore: { getState: () => ({ run: null }) },
}));
vi.mock('../debate/debate-store', () => ({
  isDebateSession: () => false,
  debateTurnDone: vi.fn(),
}));
vi.mock('../stream/session-stream-store', () => ({
  getOrInitSessionStreamState: () => ({ messages: [] }),
}));

import { makeStreamHandlers } from '../makeStreamHandlers';
import { appendBlockEvent } from '../stream/append-block-event';
import type { ChatMessage } from '@/types/chat';
import type { GitDiffResult } from '@/api/git';

const DIFF: GitDiffResult = {
  workspace: '/repo',
  added: 4,
  removed: 1,
  files: [
    { path: 'src/a.ts', status: 'M', added: 4, removed: 1, diff: '@@ -1 +1 @@' },
  ],
};

function makeHarness(diffImpl: (sessionId: string) => Promise<GitDiffResult>) {
  let messages: ChatMessage[] = [];
  const setMessages = (updater: unknown) => {
    messages =
      typeof updater === 'function'
        ? (updater as (prev: ChatMessage[]) => ChatMessage[])(messages)
        : (updater as ChatMessage[]);
  };
  const gitApi = { diff: vi.fn(diffImpl) };
  const built = makeStreamHandlers({
    sessionId: 'sess-1',
    assistantMsgId: 'a1',
    initialMessages: [],
    setMessages: setMessages,
    persistMessages: vi.fn(),
    setSessionStatus: vi.fn(),
    setWorkbenchSession: vi.fn(),
    setSubagentPrompts: vi.fn(),
    setToolProgress: vi.fn(),
    setWorkbenchBtw: vi.fn(),
    isTurnVisible: () => true,
    finishTurn: vi.fn(),
    turn: {
      turnId: 't1',
      sessionId: 'sess-1',
      assistantMsgId: 'a1',
      controller: new AbortController(),
      transport: 'workbench',
      status: 'running',
      startedAt: 0,
      updatedAt: 0,
    } as never,
    gitApi,
    streamUpdateIntervalMs: 0,
    appendBlockEvent,
  });
  return {
    handlers: built.handlers,
    getState: built.getState,
    gitApi,
    getMessages: () => messages,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('makeStreamHandlers — changedFiles from edit-class tools (3.1)', () => {
  it('fetches the git diff and populates changedFiles after an edit tool, with NO session event', async () => {
    const { handlers, getState, gitApi, getMessages } = makeHarness(async () => DIFF);
    handlers.onText?.({ content: 'I will edit the file. ' });
    handlers.onToolUse?.({ id: 'w1', name: 'write_file', input: { path: 'src/a.ts' } });
    handlers.onToolResult?.({ id: 'w1', content: 'wrote src/a.ts', status: 'done' });
    handlers.onText?.({ content: 'Done.' });
    handlers.onDone?.({});
    await vi.waitFor(() => expect(getState().changedFiles).not.toBeNull());
    expect(gitApi.diff).toHaveBeenCalledWith('sess-1');
    expect(getState().changedFiles?.files[0]?.path).toBe('src/a.ts');
    // The finalized message carries changedFiles so ChangesCard renders.
    const msg = getMessages().find((m) => m.id === 'a1');
    expect((msg?.changedFiles as GitDiffResult | undefined)?.files).toHaveLength(1);
  });

  it('counts edit_file / apply_patch / str_replace as mutations too', async () => {
    for (const name of ['edit_file', 'apply_patch', 'str_replace', 'edit_lines']) {
      const { handlers, getState, gitApi } = makeHarness(async () => DIFF);
      handlers.onToolUse?.({ id: 'x', name, input: { path: 'src/a.ts' } });
      handlers.onToolResult?.({ id: 'x', content: 'ok', status: 'done' });
      handlers.onDone?.({});
      await vi.waitFor(() => expect(gitApi.diff).toHaveBeenCalled());
      expect(getState().changedFiles).not.toBeNull();
    }
  });

  it('does NOT fetch the diff when only view/run tools ran this turn', async () => {
    const { handlers, getState, gitApi } = makeHarness(async () => DIFF);
    handlers.onToolUse?.({ id: 'r1', name: 'read_file', input: { path: 'src/a.ts' } });
    handlers.onToolResult?.({ id: 'r1', content: 'file body', status: 'done' });
    handlers.onToolUse?.({ id: 'c1', name: 'run_command', input: { command: 'ls' } });
    handlers.onToolResult?.({ id: 'c1', content: 'a.ts', status: 'done' });
    handlers.onText?.({ content: 'Nothing changed.' });
    handlers.onDone?.({});
    await flush();
    expect(gitApi.diff).not.toHaveBeenCalled();
    expect(getState().changedFiles).toBeNull();
  });

  it('ignores a FAILED edit tool (a failed write changed nothing)', async () => {
    const { handlers, getState, gitApi } = makeHarness(async () => DIFF);
    handlers.onToolUse?.({ id: 'w1', name: 'write_file', input: { path: 'src/a.ts' } });
    handlers.onToolResult?.({ id: 'w1', content: 'Error: permission denied', status: 'error' });
    handlers.onDone?.({});
    await flush();
    expect(gitApi.diff).not.toHaveBeenCalled();
    expect(getState().changedFiles).toBeNull();
  });

  it('skips the diff when the edit is still pending confirmation', async () => {
    const { handlers, getState, gitApi } = makeHarness(async () => DIFF);
    handlers.onToolUse?.({ id: 'w1', name: 'write_file', input: { path: 'src/a.ts' } });
    handlers.onToolResult?.({
      id: 'w1',
      content: JSON.stringify({ type: 'mutation_pending_confirmation', message: 'Approve?' }),
      status: 'done',
    });
    handlers.onDone?.({});
    await flush();
    expect(gitApi.diff).not.toHaveBeenCalled();
    expect(getState().changedFiles).toBeNull();
  });
});

describe('makeStreamHandlers — user-message injection is idempotent (replay)', () => {
  it('appends the same injected message once when the SSE frame is replayed', () => {
    // A wiped `chat_last_seq_*` cursor makes the reconnect replay from seq 0,
    // so the same injected-user frame can arrive twice mid-turn. The bubble is
    // keyed on the queue message id — a second delivery must not stack a twin.
    const { handlers, getMessages } = makeHarness(async () => DIFF);
    const frame = { messageId: 'q42', sessionId: 'sess-1', text: 'Hello', queuedAt: '2026-01-01T00:00:00.000Z' };

    handlers.onUserMessageInjected?.(frame);
    handlers.onUserMessageInjected?.(frame);

    const bubbles = getMessages().filter((m) => m.id === 'qm-q42');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ role: 'user', content: 'Hello', queued: true });
  });

  it('still injects a different queued message', () => {
    const { handlers, getMessages } = makeHarness(async () => DIFF);

    handlers.onUserMessageInjected?.({ messageId: 'q42', sessionId: 'sess-1', text: 'First', queuedAt: '2026-01-01T00:00:00.000Z' });
    handlers.onUserMessageInjected?.({ messageId: 'q43', sessionId: 'sess-1', text: 'Second', queuedAt: '2026-01-01T00:00:01.000Z' });

    expect(getMessages().filter((m) => m.id.startsWith('qm-')).map((m) => m.id)).toEqual([
      'qm-q42',
      'qm-q43',
    ]);
  });
});

describe('makeStreamHandlers — compaction notice is idempotent (replay)', () => {
  const INFO = {
    headCount: 10,
    tailCount: 2,
    compressedCount: 3,
    originalTokens: 5000,
    compressedTokens: 1500,
  };

  it('renders one notice when the same compaction frame is replayed', () => {
    // A wiped `chat_last_seq_*` cursor replays from seq 0, so the SAME frame
    // id can arrive twice. The card id keys on the frame id — a second
    // delivery must not stack a twin (the old Date.now()+random id did).
    const { handlers, getMessages } = makeHarness(async () => DIFF);

    handlers.onCompaction?.(INFO, 7);
    handlers.onCompaction?.(INFO, 7);

    const notices = getMessages().filter((m) => m.kind === 'compaction-notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ id: 'compaction-7', role: 'assistant' });
  });

  it('still renders distinct compactions with different frame ids', () => {
    const { handlers, getMessages } = makeHarness(async () => DIFF);

    handlers.onCompaction?.(INFO, 7);
    handlers.onCompaction?.(INFO, 8);

    expect(getMessages().filter((m) => m.kind === 'compaction-notice').map((m) => m.id)).toEqual([
      'compaction-7',
      'compaction-8',
    ]);
  });
});

describe('makeStreamHandlers — onRetrying rolls back only the failed attempt (3.2)', () => {
  it('preserves prior rounds prose + tool cards, drops the failed round partial text', () => {
    const { handlers, getState } = makeHarness(async () => DIFF);
    // Round 1: committed prose + a successful edit tool.
    handlers.onText?.({ content: 'Round1 ' });
    handlers.onToolUse?.({ id: 'w1', name: 'write_file', input: { path: 'src/a.ts' } });
    handlers.onToolResult?.({ id: 'w1', content: 'ok', status: 'done' });
    // Round 2: streams partial prose, then the model call fails → retrying.
    handlers.onText?.({ content: 'Round2 partial' });
    expect(getState().assistantContent).toBe('Round1 Round2 partial');
    handlers.onRetrying?.({ attempt: 1, maxRetries: 3, delayMs: 500, reason: 'boom' });
    const s = getState();
    // Round-1 prose survives; only the failed round-2 partial is rolled back.
    expect(s.assistantContent).toBe('Round1 ');
    // The round-1 tool card is preserved (not filtered out).
    expect(s.streamBlocks.some((b) => b.type === 'toolCall')).toBe(true);
    // The round-2 partial finalOutput block is gone.
    expect(
      s.streamBlocks.some((b) => b.type === 'finalOutput' && (b.content || '').includes('Round2')),
    ).toBe(false);
  });

  it('rolls back only the current attempt across consecutive retries of the same round', () => {
    const { handlers, getState } = makeHarness(async () => DIFF);
    handlers.onText?.({ content: 'A1 ' });
    handlers.onToolUse?.({ id: 'w1', name: 'write_file', input: { path: 'a' } });
    handlers.onToolResult?.({ id: 'w1', content: 'ok', status: 'done' });
    // Attempt 1 of round 2 streams, fails.
    handlers.onText?.({ content: 'B1 ' });
    handlers.onRetrying?.({ attempt: 1, maxRetries: 3, delayMs: 100, reason: 'x' });
    expect(getState().assistantContent).toBe('A1 ');
    // Attempt 2 of round 2 streams a different partial, fails again.
    handlers.onText?.({ content: 'B2 ' });
    handlers.onRetrying?.({ attempt: 2, maxRetries: 3, delayMs: 100, reason: 'x' });
    // Still only round-1 prose remains; the second partial was dropped too.
    expect(getState().assistantContent).toBe('A1 ');
  });

  it('wipes nothing but the failed attempt when the very first round retries', () => {
    const { handlers, getState } = makeHarness(async () => DIFF);
    handlers.onThinking?.({ content: 'thinking…' });
    handlers.onText?.({ content: 'provisional' });
    handlers.onRetrying?.({ attempt: 1, maxRetries: 3, delayMs: 100, reason: 'x' });
    const s = getState();
    expect(s.assistantContent).toBe('');
    expect(s.thinkingContent).toBe('');
  });
});

describe('makeStreamHandlers — turn_end anchoring (stop-reason badge)', () => {
  it('stamps turnEnd on the assistant message and survives finalize', async () => {
    // turn_end is emitted just BEFORE done: the anchor happens mid-stream,
    // then finalize() rebuilds the message from its own field list. A rebuild
    // that stops spreading `...msg` would silently erase the badge — this
    // pins the survival across both paths.
    const { handlers, getMessages } = makeHarness(async () => DIFF);
    handlers.onText?.({ content: 'Looping…' });

    handlers.onTurnEnd?.({ reason: 'stall-stop', rounds: 12, error: false });
    expect(getMessages().find((m) => m.id === 'a1')?.turnEnd).toEqual({
      reason: 'stall-stop',
      rounds: 12,
      error: false,
    });

    handlers.onDone?.({});
    await vi.waitFor(() => {
      expect(getMessages().find((m) => m.id === 'a1')?.turnEnd).toEqual({
        reason: 'stall-stop',
        rounds: 12,
        error: false,
      });
    });
  });

  it('leaves turnEnd undefined when the turn ends without a turn_end frame', async () => {
    const { handlers, getMessages } = makeHarness(async () => DIFF);
    handlers.onText?.({ content: 'Short answer.' });
    handlers.onDone?.({});
    await vi.waitFor(() => {
      expect(getMessages().find((m) => m.id === 'a1')?.turnEnd).toBeUndefined();
    });
  });
});
