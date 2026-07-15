/**
 * Tests for the mid-response queued-message feature.
 *
 * The feature lets a user keep typing while the model is responding.
 * Submitted messages are stored on the session's `queuedUserMessages`
 * queue and delivered to the model at the next chat-loop iteration
 * boundary (between tool_results or after a text-only turn), wrapped in
 * a `<queued_message>` envelope so the model can decide whether to act
 * on them. The UI shows an array of pills above the composer and a
 * "Queued" badge on each injected user bubble in the thread.
 *
 * Coverage:
 *  - queueWorkbenchMessage / dequeueWorkbenchMessage / getQueuedWorkbenchMessages
 *    API client functions (request shape, headers, query params).
 *  - dispatchWorkbenchEvent routes the new SSE events through to the
 *    `onUserMessageQueued` / `onUserMessageDequeued` / `onUserMessageInjected`
 *    handler callbacks.
 *  - ChatThread renders one pill per queued entry with the expected
 *    "Queued (n/m)" label and a cancel button per pill.
 *  - The injected user bubble carries the "Queued" badge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('queue-store: per-session FIFO queue', () => {
  it('exports an atom-backed map and pure helpers', async () => {
    const src = readFileSync(
      resolve(__dirname, '../sections/chat/queue-store.ts'),
      'utf8',
    );
    expect(src).toMatch(/export const \$queuedMessagesBySession/);
    expect(src).toMatch(/export function upsertQueuedMessage/);
    expect(src).toMatch(/export function removeQueuedMessage/);
    expect(src).toMatch(/export function setQueuedMessages/);
    expect(src).toMatch(/export function clearQueuedMessages/);
    // Importable via barrel.
    const mod = await import('../sections/chat/queue-store');
    expect(mod.$queuedMessagesBySession).toBeDefined();
    expect(typeof mod.upsertQueuedMessage).toBe('function');
    expect(typeof mod.removeQueuedMessage).toBe('function');
    expect(typeof mod.setQueuedMessages).toBe('function');
    expect(typeof mod.clearQueuedMessages).toBe('function');
  });

  it('upsert is idempotent for the same id (avoids double-insert from SSE echo)', () => {
    return import('../sections/chat/queue-store').then((mod) => {
      const sid = 'sess-1';
      mod.clearQueuedMessages(sid);
      const entry = { id: 'qm_1', text: 'hi', queuedAt: '2026-07-01T00:00:00Z' };
      mod.upsertQueuedMessage(sid, entry);
      mod.upsertQueuedMessage(sid, entry);
      const list = mod.$queuedMessagesBySession.get()[sid] ?? [];
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('qm_1');
      mod.clearQueuedMessages(sid);
    });
  });

  it('remove drops a single entry; clearing empties the list', () => {
    return import('../sections/chat/queue-store').then((mod) => {
      const sid = 'sess-2';
      mod.setQueuedMessages(sid, [
        { id: 'a', text: 'first', queuedAt: '' },
        { id: 'b', text: 'second', queuedAt: '' },
      ]);
      mod.removeQueuedMessage(sid, 'a');
      const after = mod.$queuedMessagesBySession.get()[sid] ?? [];
      expect(after.map((e) => e.id)).toEqual(['b']);
      mod.clearQueuedMessages(sid);
      expect(mod.$queuedMessagesBySession.get()[sid]).toBeUndefined();
    });
  });
});

describe('workbench API client: queue endpoints', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('queueWorkbenchMessage POSTs to /chat/queue and returns the entry', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => ({
        id: 'qm_abc',
        text: 'use postgres',
        attachments: [],
        queuedAt: '2026-07-01T00:00:00Z',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { queueWorkbenchMessage } = await import('../api/workbench');
    const entry = await queueWorkbenchMessage('wb_sess', 'use postgres');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/chat/queue',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'wb_sess',
          text: 'use postgres',
          attachments: [],
          kind: 'queue',
        }),
      }),
    );
    expect(entry.id).toBe('qm_abc');
  });

  it('dequeueWorkbenchMessage DELETEs /chat/queue/{id} with sessionId query', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const { dequeueWorkbenchMessage } = await import('../api/workbench');
    await dequeueWorkbenchMessage('wb_sess', 'qm_abc');
    const called = fetchMock.mock.calls[0];
    const [url, init] = called;
    expect(url).toContain('/api/workbench/chat/queue/qm_abc');
    expect(url).toContain('sessionId=wb_sess');
    expect(init.method).toBe('DELETE');
  });

  it('getQueuedWorkbenchMessages GETs /chat/queue and returns the messages array', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => ({
        sessionId: 'wb_sess',
        messages: [
          { id: 'qm_1', text: 'a', queuedAt: '' },
          { id: 'qm_2', text: 'b', queuedAt: '' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getQueuedWorkbenchMessages } = await import('../api/workbench');
    const list = await getQueuedWorkbenchMessages('wb_sess');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/workbench/chat/queue?sessionId=wb_sess');
    expect(list).toHaveLength(2);
  });

  it('clearQueuedWorkbenchMessages DELETEs /chat/queue', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => ({ cleared: 2 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { clearQueuedWorkbenchMessages } = await import('../api/workbench');
    const res = await clearQueuedWorkbenchMessages('wb_sess');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/workbench/chat/queue?sessionId=wb_sess');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(res.cleared).toBe(2);
  });

  it('reorderQueuedWorkbenchMessages PATCHes order', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => ({ messages: [{ id: 'b' }, { id: 'a' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { reorderQueuedWorkbenchMessages } = await import('../api/workbench');
    const list = await reorderQueuedWorkbenchMessages('wb_sess', ['b', 'a']);
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(list.map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('ChatThread: queue pill rendering and queue badge', () => {
  it('renders QueuePills for queued entries with clear-all / reorder support', () => {
    const threadSrc = readFileSync(
      resolve(__dirname, '../sections/chat/ChatThread.tsx'),
      'utf8',
    );
    expect(threadSrc).toMatch(/QueuePills/);
    const pillsSrc = readFileSync(
      resolve(__dirname, '../sections/chat/QueuePills.tsx'),
      'utf8',
    );
    expect(pillsSrc).toMatch(/workbenchClient\.dequeueMessage|dequeueWorkbenchMessage/);
    expect(pillsSrc).toMatch(/Clear all|clearAll/);
    expect(pillsSrc).toMatch(/workbenchClient\.reorderQueue|reorderQueuedWorkbenchMessages|Drag to reorder/);
    expect(pillsSrc).toMatch(/i \+ 1.*items\.length/);
  });

  it('injected user bubbles get a "Queued" badge', () => {
    // Queued badge lives on MessageBubble.
    const src = readFileSync(
      resolve(__dirname, '../sections/chat/MessageBubble.tsx'),
      'utf8',
    );
    expect(src).toMatch(/message\.queued\s*&&/);
    // The "Queued" badge text appears as plain text inside the badge div.
    expect(src).toMatch(/Queued<\/div>|Queued\s*<\/span>|>\s*Queued\s*</);
  });

  it('send() routes streaming-time input to queueWorkbenchMessage instead of dropping', () => {
    const src = readFileSync(
      resolve(__dirname, '../sections/chat/ChatThread.tsx'),
      'utf8',
    );
    // When streaming, the queue branch must call the backend queue API
    // and not just hold the message locally (steer mid-run).
    expect(src).toMatch(/streaming\s*&&\s*sessionId[\s\S]{0,800}queueWorkbenchMessage/);
    // The old single-slot state should be gone.
    expect(src).not.toMatch(/setQueuedMessage\b/);
    expect(src).not.toMatch(/useState<\{\s*text:\s*string;\s*attachments/);
  });
});

describe('SSE dispatch: queue events route to the new handlers', () => {
  it('workbench.ts dispatches userMessageQueued / userMessageDequeued / userMessageInjected', () => {
    const src = readFileSync(
      resolve(__dirname, '../api/workbench.ts'),
      'utf8',
    );
    // The SSE event payload uses camelCase discriminator strings
    // (`userMessageQueued`, etc.) — the schema literals live in
    // src/api/schemas/workbench.ts and the dispatch switch in workbench.ts.
    expect(src).toMatch(/case 'userMessageQueued'/);
    expect(src).toMatch(/case 'userMessageDequeued'/);
    expect(src).toMatch(/case 'userMessageInjected'/);
    expect(src).toMatch(/handlers\.onUserMessageQueued\?/);
    expect(src).toMatch(/handlers\.onUserMessageDequeued\?/);
    expect(src).toMatch(/handlers\.onUserMessageInjected\?/);
  });

  it('WorkbenchEventHandlers type exposes the three new callbacks', () => {
    const src = readFileSync(
      resolve(__dirname, '../types/workbench.ts'),
      'utf8',
    );
    expect(src).toMatch(/onUserMessageQueued\?:/);
    expect(src).toMatch(/onUserMessageDequeued\?:/);
    expect(src).toMatch(/onUserMessageInjected\?:/);
  });
});

describe('chat-stream-manager subscriber wires queue events to the queue-store', () => {
  it('forwards SSE queue events to upsert / remove / set on the queue-store', () => {
    const src = readFileSync(
      resolve(__dirname, '../sections/chat/chat-stream-manager.ts'),
      'utf8',
    );
    // The per-session subscriber should wire all three callbacks.
    expect(src).toMatch(/onUserMessageQueued:/);
    expect(src).toMatch(/onUserMessageDequeued:/);
    expect(src).toMatch(/onUserMessageInjected:/);
    // And each one should hit the queue-store helper.
    expect(src).toMatch(/upsertQueuedMessage\(data\.sessionId/);
    expect(src).toMatch(/removeQueuedMessage\(data\.sessionId/);
    // onUserMessageInjected should also append a synthetic user bubble
    // to the per-session message log via updateSessionStreamState.
    expect(src).toMatch(/queued:\s*true/);
  });
});