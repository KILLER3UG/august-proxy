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
