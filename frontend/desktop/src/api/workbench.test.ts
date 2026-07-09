/* Tests for workbench SSE streaming resilience (Chunk 5).
 *
 * Asserts the two issue-#2 frontend guarantees:
 *   1. `readSseStream` returns receivedTerminalEvent=true ONLY for
 *      done/error/aborted — a premature drop (no terminal event) is
 *      detectable so the caller can retry instead of finalizing as error.
 *   2. `streamWorkbenchReconnect` retries on a premature drop rather than
 *      surfacing an error on the first lost connection, and converges when
 *      a terminal event arrives.
 *
 * `readSseStream` is not exported, so we exercise it through
 * `streamWorkbenchReconnect`, which is exported. fetch + ReadableStream
 * are mocked so no real network is involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamWorkbenchReconnect } from './workbench';

// ── Helpers: build a fake SSE Response from raw event lines ───────────

function sseResponse(lines: string[], { status = 200 }: { status?: number } = {}): Response {
  const body = lines.join('\n') + '\n\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// A response whose stream closes immediately with NO data — simulates a
// premature connection drop (no terminal event).
function emptyDroppedResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const doneEvent = [
  'event: done',
  'data: {"sessionId":"wb_test"}',
  'id: 5',
];

const errorEvent = [
  'event: error',
  'data: {"message":"boom"}',
  'id: 5',
];

const abortedEvent = [
  'event: aborted',
  'data: {}',
  'id: 5',
];

// A normal text event followed by done — simulates a healthy stream.
const textThenDone = [
  'event: final_output',
  'data: {"content":"hi"}',
  'id: 3',
  '',
  'event: done',
  'data: {"sessionId":"wb_test"}',
  'id: 4',
];

// ── Tests ────────────────────────────────────────────────────────────

describe('streamWorkbenchReconnect terminal-event detection', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('treats done as terminal and stops retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(doneEvent));
    globalThis.fetch = fetchMock as any;

    const onDone = vi.fn();
    const onError = vi.fn();
    await streamWorkbenchReconnect(
      'wb_test',
      { onDone, onError },
      undefined,
      0,
      { maxRetries: 3 },
    );

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    // Terminal event → exactly one fetch, no retries.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats error as terminal and does NOT retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(errorEvent));
    globalThis.fetch = fetchMock as any;

    const onDone = vi.fn();
    const onError = vi.fn();
    await streamWorkbenchReconnect(
      'wb_test',
      { onDone, onError },
      undefined,
      0,
      { maxRetries: 3 },
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats aborted as terminal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(abortedEvent));
    globalThis.fetch = fetchMock as any;

    const onDone = vi.fn();
    await streamWorkbenchReconnect(
      'wb_test',
      { onDone },
      undefined,
      0,
      { maxRetries: 3 },
    );

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a healthy stream with a final done event does not error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(textThenDone));
    globalThis.fetch = fetchMock as any;

    const onDone = vi.fn();
    const onError = vi.fn();
    await streamWorkbenchReconnect(
      'wb_test',
      { onDone, onError },
      undefined,
      0,
      { maxRetries: 3 },
    );

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('streamWorkbenchReconnect retries on premature drop', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('retries when the stream drops with no terminal event, then converges on done', async () => {
    // First call: drops prematurely (empty body, no terminal). Second call:
    // a real done event. The retry must converge — not surface an error.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyDroppedResponse())
      .mockResolvedValueOnce(sseResponse(doneEvent));
    globalThis.fetch = fetchMock as any;

    const onDone = vi.fn();
    const onError = vi.fn();
    await streamWorkbenchReconnect(
      'wb_test',
      { onDone, onError },
      undefined,
      0,
      { maxRetries: 3 },
    );

    expect(onDone).toHaveBeenCalledTimes(1);
    // A premature drop must NOT surface as a user-visible error when a
    // subsequent retry succeeds.
    expect(onError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces an error only after exhausting the bounded retry budget', async () => {
    // Every call drops prematurely — never a terminal event.
    const fetchMock = vi.fn().mockResolvedValue(emptyDroppedResponse());
    globalThis.fetch = fetchMock as any;

    const onError = vi.fn();
    const onDone = vi.fn();
    // Tiny budget so the test doesn't wait on backoff. The backoff uses
    // baseDelayMs * 2^(retry-1) + jitter; with baseDelayMs=1000 the first
    // retry waits ~1s. Keep budget=1 → one retry, then surface error.
    await streamWorkbenchReconnect(
      'wb_test',
      { onDone, onError },
      undefined,
      0,
      { maxRetries: 1 },
    );

    // Budget exhausted → initial call + 1 retry = 2 fetches, then onError.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('unbounded retries (subscriber path) keep retrying past a small budget', async () => {
    // Drop twice, then deliver done. With maxRetries: Infinity this must
    // converge rather than surfacing an error after the first drop.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyDroppedResponse())
      .mockResolvedValueOnce(emptyDroppedResponse())
      .mockResolvedValueOnce(sseResponse(doneEvent));
    globalThis.fetch = fetchMock as any;

    const onDone = vi.fn();
    const onError = vi.fn();
    await streamWorkbenchReconnect(
      'wb_test',
      { onDone, onError },
      undefined,
      0,
      { maxRetries: Infinity },
    );

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
