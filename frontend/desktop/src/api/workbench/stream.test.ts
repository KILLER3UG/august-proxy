/* Tests for the SSE frame parser in workbench/stream.ts.
 *
 * The backend emits each frame as `event: <type>\ndata: <json>\nid: <seq>`
 * with the id AFTER the data. The parser must buffer the whole frame before
 * dispatch — otherwise the CURRENT frame's event is paired with the PREVIOUS
 * frame's seq, and the terminal `done` frame's seq is never persisted
 * (reconnects would replay tail events).
 *
 * `readSseStream` is not exported, so we exercise it through
 * `streamWorkbenchReconnect`, which is exported (fetch + ReadableStream
 * are mocked so no real network is involved).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamWorkbenchReconnect } from './stream';
import { getStreamReconnecting } from '@/store/streamLink';

// ── Helpers: build a fake SSE Response from raw event lines ───────────

function sseResponse(lines: string[]): Response {
  const body = lines.join('\n') + '\n\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('SSE frame parser — id: after data:', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('pairs each frame with its OWN id (not the previous frame\'s)', async () => {
    // Two frames, both with `id:` AFTER `data:` — the ordering that used to
    // misattribute: frame 1 (final_output, id 3) then frame 2 (done, id 4).
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'event: final_output',
        'data: {"content":"hi"}',
        'id: 3',
        '',
        'event: done',
        'data: {"sessionId":"wb_test"}',
        'id: 4',
      ]),
    );
    globalThis.fetch = fetchMock as any;

    const onSeq = vi.fn();
    const onText = vi.fn();
    const onDone = vi.fn();
    await streamWorkbenchReconnect(
      'wb_test',
      { onSeq, onText, onDone },
      undefined,
      0,
      { maxRetries: 0 },
    );

    // onText fires for the final_output frame, onDone for the done frame.
    expect(onText).toHaveBeenCalledWith({ content: 'hi' });
    expect(onDone).toHaveBeenCalledTimes(1);
    // onSeq receives the frame's OWN id and event type, in dispatch order.
    expect(onSeq.mock.calls).toEqual([
      [3, 'final_output'],
      [4, 'done'],
    ]);
  });

  it('persists the terminal done frame\'s seq (no tail replay on reconnect)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'event: text',
        'data: {"content":"part one"}',
        'id: 7',
        '',
        'event: done',
        'data: {"sessionId":"wb_test"}',
        'id: 8',
      ]),
    );
    globalThis.fetch = fetchMock as any;

    const onSeq = vi.fn();
    await streamWorkbenchReconnect(
      'wb_test',
      { onSeq },
      undefined,
      0,
      { maxRetries: 0 },
    );

    // The LAST frame's seq (8, the done frame) must reach onSeq so the
    // durable subscriber persists it — reconnects then resume after the
    // turn instead of replaying the tail events.
    expect(onSeq).toHaveBeenCalledWith(8, 'done');
  });

  it('works when id: precedes data: (legacy ordering) and with unnamed data frames', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'id: 11',
        'data: {"content":"hi"}',
        '',
        'data: {"content":"again"}',
        'id: 12',
        '',
        'event: done',
        'data: {"sessionId":"wb_test"}',
        'id: 13',
      ]),
    );
    globalThis.fetch = fetchMock as any;

    const onSeq = vi.fn();
    const onText = vi.fn();
    const onDone = vi.fn();
    await streamWorkbenchReconnect(
      'wb_test',
      { onSeq, onText, onDone },
      undefined,
      0,
      { maxRetries: 0 },
    );

    // Unnamed data frames still dispatch (empty event name falls through
    // the switch) and carry their own seq; done closes the turn.
    expect(onSeq.mock.calls).toEqual([
      [11, ''],
      [12, ''],
      [13, 'done'],
    ]);
    expect(onText).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

// ── Reconnect visibility: the retry loop must tell the link store ──────

describe('streamWorkbenchReconnect — link state for the UI', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('marks the session reconnecting on a dropped stream and clears it on resume', async () => {
    const observed: Array<number | null> = [];
    let call = 0;
    globalThis.fetch = vi.fn((): Promise<Response> => {
      call += 1;
      if (call === 1) {
        // Frames but no terminal event — the connection dropped mid-turn.
        return Promise.resolve(
          sseResponse(['event: text', 'data: {"content":"par"}', 'id: 1']),
        );
      }
      observed.push(getStreamReconnecting('wb_link')?.attempt ?? null);
      return Promise.resolve(
        sseResponse(['event: done', 'data: {"sessionId":"wb_link"}', 'id: 2']),
      );
    });

    const run = streamWorkbenchReconnect('wb_link', {}, undefined, 0, { maxRetries: 3 });
    await vi.runAllTimersAsync();
    await run;

    // The reconnect attempt was visible while the next connection was opened…
    expect(observed).toEqual([1]);
    // …and the flag is gone once events flow again, so the banner disappears.
    expect(getStreamReconnecting('wb_link')).toBeNull();
  });

  it('clears the flag the moment the stream reconnects, before any event arrives', async () => {
    // Regression: the banner used to be cleared only by `onSeq` or loop exit.
    // An idle session that reconnects cleanly emits nothing, so "Stream
    // interrupted — reconnecting" sat on screen until the next turn started.
    const ctrl = new AbortController();
    let call = 0;
    globalThis.fetch = vi.fn((): Promise<Response> => {
      call += 1;
      if (call === 1) {
        // Frames but no terminal event — the drop that raises the banner.
        return Promise.resolve(
          sseResponse(['event: text', 'data: {"content":"par"}', 'id: 1']),
        );
      }
      // Reconnected, but the session is idle: the stream stays open and never
      // emits, so nothing downstream can be what clears the flag.
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              /* never enqueues, never closes */
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });

    const run = streamWorkbenchReconnect('wb_link_idle', {}, ctrl.signal, 0, { maxRetries: 3 });
    run.catch(() => {}); // left pending on purpose: the idle stream never ends

    // Fire ONLY the backoff sleep (attempt 1 waits < 2s). Advancing further
    // would also fire the reader's 120s idle timeout and end the stream,
    // which is exactly the "connection dropped" path this test must avoid.
    await vi.advanceTimersByTimeAsync(3000);

    expect(call, 'the second connection must have been opened').toBe(2);
    expect(getStreamReconnecting('wb_link_idle')).toBeNull();
  });

  it('clears the flag instead of leaving it stuck when the budget runs out', async () => {
    globalThis.fetch = vi.fn((): Promise<Response> => Promise.reject(new Error('connection refused')));

    const onError = vi.fn();
    const run = streamWorkbenchReconnect('wb_link2', { onError }, undefined, 0, { maxRetries: 1 });
    await vi.runAllTimersAsync();
    await run;

    expect(onError).toHaveBeenCalled();
    expect(getStreamReconnecting('wb_link2')).toBeNull();
  });

  it('clears the flag when the caller aborts mid-backoff', async () => {
    // Real timers: the abort has to land while the backoff sleep is pending,
    // and rejecting that sleep under fake timers escapes as an uncaught error.
    vi.useRealTimers();
    globalThis.fetch = vi.fn((): Promise<Response> => Promise.reject(new Error('connection refused')));

    const ctrl = new AbortController();
    const run = streamWorkbenchReconnect('wb_link3', {}, ctrl.signal, 0, { maxRetries: 5 });
    // Let the first failure register the retry, then detach as a session
    // switch would.
    await new Promise((r) => setTimeout(r, 50));
    expect(getStreamReconnecting('wb_link3')?.attempt).toBe(1);
    ctrl.abort();

    await expect(run).rejects.toThrow(/aborted/i);
    expect(getStreamReconnecting('wb_link3')).toBeNull();
  });
});
