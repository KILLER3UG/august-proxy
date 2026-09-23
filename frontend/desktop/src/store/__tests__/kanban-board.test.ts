import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useKanbanStore, type KanbanCard } from '../kanban-board';

const SERVER_CARD: KanbanCard = {
  id: 'kb_server1',
  title: 'From the server',
  column: 'doing',
  agentId: 'agent-2',
  // Empty strings come back from the API; the store normalizes them to
  // undefined so a card with no agent does not render "@".
  createdAt: 2000,
  updatedAt: 2000,
};

type Recorded = { key: string; body?: Record<string, unknown> };

function stubFetch(routes: Record<string, unknown>) {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown, init?: RequestInit) => {
      const path = String(url).replace('/api/kanban', '');
      const method = init?.method ?? 'GET';
      const key = `${method} ${path}`;
      calls.push({
        key,
        body:
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined,
      });
      const payload = key in routes ? routes[key] : {};
      const failed = payload === 'fail';
      return Promise.resolve(
        new Response(failed ? '{}' : JSON.stringify(payload), {
          status: failed ? 503 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

/** The store fires writes without awaiting them; drain the microtasks and the
 *  stubbed promise chain so the resulting state is observable. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  useKanbanStore.setState({ cards: [], hydrated: false });
});

describe('kanban-board store — one shared, server-backed board', () => {
  it('imports a pre-existing browser board once, then reads the server', async () => {
    localStorage.setItem(
      'august-kanban-board-v1',
      JSON.stringify([{ id: 'kb_local', title: 'Mine', column: 'backlog', createdAt: 1, updatedAt: 1 }]),
    );
    const calls = stubFetch({ 'POST /import': { ok: true, added: 1 }, 'GET ': { cards: [SERVER_CARD] } });

    useKanbanStore.getState().hydrate();
    await settle();

    expect(calls.map((c) => c.key)).toEqual(['POST /import', 'GET ']);
    expect(calls[0].body?.cards).toHaveLength(1);
    expect(localStorage.getItem('august-kanban-board-v1.imported')).toBe('1');
    // The legacy copy is kept, not eaten, so a failed import can retry.
    expect(localStorage.getItem('august-kanban-board-v1')).toContain('kb_local');
    expect(useKanbanStore.getState().cards).toEqual([SERVER_CARD]);
    expect(useKanbanStore.getState().hydrated).toBe(true);
  });

  it('does not re-import on the second hydrate', async () => {
    localStorage.setItem('august-kanban-board-v1.imported', '1');
    localStorage.setItem(
      'august-kanban-board-v1',
      JSON.stringify([{ id: 'kb_local', title: 'Mine', column: 'backlog', createdAt: 1, updatedAt: 1 }]),
    );
    const calls = stubFetch({ 'GET ': { cards: [] } });

    useKanbanStore.getState().hydrate();
    await settle();

    expect(calls.map((c) => c.key)).toEqual(['GET ']);
  });

  it('swaps the optimistic placeholder for the saved card', async () => {
    stubFetch({
      'POST ': { ...SERVER_CARD, title: 'Typed by hand' },
      'GET ': { cards: [] },
    });
    useKanbanStore.setState({ hydrated: true });

    const pending = useKanbanStore.getState().addCard('Typed by hand', 'doing');
    expect(pending.id).toMatch(/^tmp_/);
    await settle();

    expect(useKanbanStore.getState().cards).toEqual([
      expect.objectContaining({ id: 'kb_server1', column: 'doing' }),
    ]);
  });

  it('drops the placeholder and re-reads when the write cannot be saved', async () => {
    const calls = stubFetch({ 'POST ': 'fail', 'GET ': { cards: [SERVER_CARD] } });
    useKanbanStore.setState({ hydrated: true });

    useKanbanStore.getState().addCard('Nowhere to go');
    await settle();
    await settle();

    expect(useKanbanStore.getState().cards).toEqual([SERVER_CARD]);
    expect(calls.map((c) => c.key)).toContain('GET ');
  });

  it('moves through the API, not just locally', async () => {
    const calls = stubFetch({
      'PATCH /kb_server1': { ...SERVER_CARD, column: 'review' },
      'GET ': { cards: [] },
    });
    useKanbanStore.setState({ hydrated: true, cards: [SERVER_CARD] });

    useKanbanStore.getState().moveCard('kb_server1', 'review');
    await settle();

    expect(calls[0]).toEqual({ key: 'PATCH /kb_server1', body: { column: 'review' } });
    expect(useKanbanStore.getState().cards[0].column).toBe('review');
  });

  it('refuses a column the server does not know about', () => {
    const calls = stubFetch({ 'GET ': { cards: [] } });
    useKanbanStore.setState({ hydrated: true, cards: [SERVER_CARD] });

    useKanbanStore.getState().moveCard('kb_server1', 'shredded' as never);

    expect(calls).toHaveLength(0);
    expect(useKanbanStore.getState().cards[0].column).toBe('doing');
  });
});
