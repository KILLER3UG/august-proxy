import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types/chat';

const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const isTombstoned = vi.hoisted(() => vi.fn((_id: string) => false));

vi.mock('@/api/client', () => ({
  api: { post, patch },
  ApiError: class ApiError extends Error {
    constructor(public status: number, _code: string, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

vi.mock('@/store/sessions', () => ({
  isSessionIdTombstoned: (id: string) => isTombstoned(id),
  // session-stream-store reads this on first init only; an empty roster is
  // enough for a transcript that carries no workbench session.
  useSessionsStore: { getState: () => ({ sessions: [] }), setState: () => undefined },
}));

import {
  flushTranscriptSync,
  resetTranscriptSync,
  scheduleTranscriptSync,
  syncedMessageIds,
} from '../transcript-sync';
import { updateSessionStreamState } from '../session-stream-store';

const DEBOUNCE = 1_200;

function userMsg(id: string, content = 'hello'): ChatMessage {
  return { id, role: 'user', content, timestamp: new Date().toISOString() };
}

/** A user bubble carrying a structured sibling field (attachments) — the
 *  shape that turns a later sync into a blocks-only PATCH. */
function userMsgWithAttachment(id: string): ChatMessage {
  return {
    ...userMsg(id),
    attachments: [{ id: 'f1', name: 'notes.md', type: 'text', status: 'ready' }],
  } as ChatMessage;
}

function assistantMsg(id: string, blocks: ChatMessage['blocks'] = []): ChatMessage {
  return { id, role: 'assistant', content: 'done', timestamp: new Date().toISOString(), blocks };
}

beforeEach(() => {
  vi.useFakeTimers();
  post.mockReset().mockResolvedValue({ id: 1, status: 'ok' });
  patch.mockReset().mockResolvedValue({ status: 'ok' });
  isTombstoned.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('scheduleTranscriptSync', () => {
  it('posts the client message once, then patches it on later syncs', async () => {
    const sessionId = 'sess-sync-1';
    scheduleTranscriptSync(sessionId, [userMsg('m1')]);
    expect(post).not.toHaveBeenCalled(); // debounced — send never waits

    vi.advanceTimersByTime(DEBOUNCE);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(`/api/sessions/${sessionId}/messages`);
    expect(body.clientMessageId).toBe('m1');
    expect(body.role).toBe('user');
    expect(body.content).toBe('hello');
    expect(patch).not.toHaveBeenCalled();

    // Server accepted it: the next sync is a cheap blocks-only PATCH.
    await vi.advanceTimersByTimeAsync(0);
    expect(syncedMessageIds(sessionId)).toEqual(['m1']);

    scheduleTranscriptSync(sessionId, [userMsgWithAttachment('m1'), assistantMsg('a1')]);
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(0);

    expect(post).toHaveBeenCalledTimes(2); // only the new a1
    expect(patch).toHaveBeenCalledTimes(1);
    const [patchUrl, patchBody] = patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(patchUrl).toBe(`/api/sessions/${sessionId}/messages/enrichment`);
    expect(patchBody.clientMessageId).toBe('m1');
    // Enrichment never carries the text — the server must not rewrite FTS.
    expect(patchBody.content).toBeUndefined();
  });

  it('coalesces a burst of edits into one request', () => {
    const sessionId = 'sess-sync-burst';
    for (let i = 0; i < 20; i++) {
      scheduleTranscriptSync(sessionId, [userMsg('m1', `draft ${i}`)]);
    }
    vi.advanceTimersByTime(DEBOUNCE);
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0] as [string, Record<string, unknown>])[1].content).toBe('draft 19');
  });

  it('skips restored (remote) and tool rows so a restore cannot duplicate bubbles', () => {
    const sessionId = 'sess-sync-remote';
    scheduleTranscriptSync(sessionId, [
      { ...userMsg('7'), remote: true },
      { ...assistantMsg('8'), role: 'tool' },
    ]);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(post).not.toHaveBeenCalled();
  });

  it('never writes into a deleted session', () => {
    isTombstoned.mockReturnValue(true);
    scheduleTranscriptSync('sess-sync-dead', [userMsg('m1')]);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(post).not.toHaveBeenCalled();
  });

  it('waits for backend history instead of syncing a partial transcript', () => {
    const sessionId = 'sess-sync-loading';
    // A history fetch in flight (no `messages` in the patch — an explicit
    // transcript replacement would mark the session ready on its own).
    updateSessionStreamState(
      sessionId,
      () => ({ history: { status: 'loading' } }),
      { transcriptUpdate: 'stream' },
    );
    scheduleTranscriptSync(sessionId, [userMsg('m1')]);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(post).not.toHaveBeenCalled();

    updateSessionStreamState(sessionId, () => ({ history: { status: 'ready' } }));
    scheduleTranscriptSync(sessionId, [userMsg('m1')]);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('re-posts after a 404 so a rewritten row is claimed again', async () => {
    const sessionId = 'sess-sync-404';
    const { ApiError } = await import('@/api/client');
    scheduleTranscriptSync(sessionId, [userMsg('m1')]);
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncedMessageIds(sessionId)).toEqual(['m1']);

    // The workbench rewrite dropped the row: the enrichment PATCH 404s.
    patch.mockRejectedValueOnce(new ApiError(404, 'unknown', 'Message not found'));
    scheduleTranscriptSync(sessionId, [userMsgWithAttachment('m1')]);
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncedMessageIds(sessionId)).toEqual([]);

    // Next sync falls back to the idempotent POST.
    scheduleTranscriptSync(sessionId, [userMsgWithAttachment('m1')]);
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(syncedMessageIds(sessionId)).toEqual(['m1']);
  });

  it('keeps working when a request fails (fire and forget)', async () => {
    const sessionId = 'sess-sync-offline';
    post.mockRejectedValueOnce(new Error('offline'));
    scheduleTranscriptSync(sessionId, [userMsg('m1')]);
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncedMessageIds(sessionId)).toEqual([]);

    // Retried (as a POST again) on the next sync — no PATCH for an unclaimed id.
    scheduleTranscriptSync(sessionId, [userMsg('m1')]);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('clips an oversized block so one preview cannot blow the request budget', () => {
    const sessionId = 'sess-sync-big';
    const huge = 'x'.repeat(60_000);
    scheduleTranscriptSync(sessionId, [
      assistantMsg('a1', [{ id: 'b1', type: 'finalOutput', content: huge }]),
    ]);
    vi.advanceTimersByTime(DEBOUNCE);
    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    const blocks = body.blocks as Array<{ content: string }>;
    expect(blocks[0].content.length).toBeLessThanOrEqual(4_001);
  });
});

describe('flushTranscriptSync', () => {
  it('syncs the live transcript on finalize without waiting', async () => {
    const sessionId = 'sess-flush';
    const assistant = assistantMsg('a1', [{ id: 'b1', type: 'finalOutput', content: 'done' }]);
    updateSessionStreamState(
      sessionId,
      () => ({ messages: [userMsg('m1'), assistant], history: { status: 'ready' } }),
    );

    flushTranscriptSync(sessionId);

    expect(post).toHaveBeenCalledTimes(2);
    const ids = post.mock.calls.map(
      (call) => (call as [string, Record<string, unknown>])[1].clientMessageId,
    );
    expect(ids).toEqual(['m1', 'a1']);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('cancels the pending debounce instead of double-sending', async () => {
    const sessionId = 'sess-flush-cancel';
    scheduleTranscriptSync(sessionId, [userMsg('m1')]);
    flushTranscriptSync(sessionId);
    expect(post).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DEBOUNCE * 2);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('resetTranscriptSync drops pending work and claims for a deleted chat', async () => {
    const sessionId = 'sess-reset';
    scheduleTranscriptSync(sessionId, [userMsg('m1')]);
    flushTranscriptSync(sessionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncedMessageIds(sessionId)).toEqual(['m1']);

    resetTranscriptSync(sessionId);
    expect(syncedMessageIds(sessionId)).toEqual([]);
    scheduleTranscriptSync(sessionId, [userMsg('m1')]);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(post).toHaveBeenCalledTimes(2);
  });
});
