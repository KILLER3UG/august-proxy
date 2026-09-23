import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mocks, CARDS } = vi.hoisted(() => ({
  mocks: {
    navigate: vi.fn(),
    hydrate: vi.fn(),
    addCard: vi.fn(),
    moveCard: vi.fn(),
    removeCard: vi.fn(),
    assignCard: vi.fn(),
    clearDone: vi.fn(),
  },
  CARDS: [
    {
      id: 'card-1',
      title: 'Rebalance the retry budget',
      body: 'Backoff is flat; make it exponential.',
      column: 'doing' as const,
      agentId: 'agent-7',
      sessionId: 'wb_42',
      createdAt: 100,
      updatedAt: 100,
    },
    {
      id: 'card-2',
      title: 'Orphan session card',
      column: 'backlog' as const,
      sessionId: 'wb_gone',
      createdAt: 90,
      updatedAt: 90,
    },
  ],
}));

vi.mock('@/store/kanban-board', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store/kanban-board')>();
  const state = {
    cards: CARDS,
    hydrated: true,
    hydrate: mocks.hydrate,
    addCard: mocks.addCard,
    moveCard: mocks.moveCard,
    removeCard: mocks.removeCard,
    assignCard: mocks.assignCard,
    clearDone: mocks.clearDone,
  };
  return { ...actual, useKanbanStore: (sel: (s: typeof state) => unknown) => sel(state) };
});

vi.mock('@/api/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/api-client')>()),
  listBots: vi.fn(() => Promise.resolve({
    bots: [
      { id: 'agent-7', name: 'Reviewer', uiMeta: { hidden: false } },
      { id: 'agent-8', name: 'Librarian', uiMeta: { hidden: false } },
      { id: 'agent-hidden', name: 'Ghost', uiMeta: { hidden: true } },
    ],
  })),
}));

vi.mock('@/store/sessions', () => ({
  useSessionsStore: (sel: (s: { sessions: unknown[] }) => unknown) =>
    sel({ sessions: [{ id: 'sess_ui', workbenchSessionId: 'wb_42', title: 'A chat' }] }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

import { KanbanSection } from '../KanbanSection';

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KanbanSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KanbanSection — the human half of the shared board', () => {
  it('shows which agent holds a card, and lets a person reassign it', async () => {
    renderSection();

    const select = await screen.findByLabelText<HTMLSelectElement>('Agent for Rebalance the retry budget');
    // The owner an agent claimed is readable, not just stored.
    expect(select).toHaveValue('agent-7');
    // The roster arrives asynchronously; choosing before it lands would set ''
    // and the assertion below would be about a race, not about the wiring.
    await waitFor(() =>
      expect(Array.from(select.options).map((o) => o.value)).toContain('agent-8'),
    );

    fireEvent.change(select, { target: { value: 'agent-8' } });
    expect(mocks.assignCard).toHaveBeenCalledWith('card-1', 'agent-8');
  });

  it('offers only bots in the visible roster, plus a card owner that is not', async () => {
    renderSection();
    const free = await screen.findByLabelText<HTMLSelectElement>('Agent for Orphan session card');
    await waitFor(() => expect(free.options.length).toBeGreaterThan(1));
    const values = Array.from(free.options).map((o) => o.value);
    expect(values).toContain('agent-8');
    expect(values).not.toContain('agent-hidden');

    // card-1 is held by agent-7, which IS in the roster, so no extra option;
    // a card held by a deleted bot still shows its owner rather than "Unassigned".
    const held = screen.getByLabelText('Agent for Rebalance the retry budget');
    expect(held).toHaveValue('agent-7');
  });

  it('opens the session that created a card, and offers nothing when that session is gone', async () => {
    renderSection();
    await screen.findByText('Rebalance the retry budget');

    const link = screen.getByRole('button', { name: /open the session that created/i });
    fireEvent.click(link);
    // The card carries the workbench id; the route needs the sidebar one.
    expect(mocks.navigate).toHaveBeenCalledWith('/c/sess_ui');

    // card-2's session is not in the roster of known sessions: a link that
    // would land on a missing conversation is worse than no link.
    expect(screen.getAllByRole('button', { name: /open the session that created/i })).toHaveLength(
      1,
    );
  });

  it('accepts a dropped card on a column that already has cards', async () => {
    renderSection();
    const doneColumn = (await screen.findByText('Done · 0')).closest('div');
    expect(doneColumn).toBeTruthy();

    fireEvent.dragOver(doneColumn!);
    fireEvent.drop(doneColumn!, { dataTransfer: { getData: () => 'card-1' } });

    expect(mocks.moveCard).toHaveBeenCalledWith('card-1', 'done');
  });

  it('shows the card body so a handoff note is readable without opening anything', async () => {
    renderSection();
    expect(await screen.findByText('Backoff is flat; make it exponential.')).toBeInTheDocument();
  });

  it('lets a person write the handoff note an agent would have written', async () => {
    renderSection();
    fireEvent.change(await screen.findByPlaceholderText('New card title…'), {
      target: { value: 'Triage the flaky suite' },
    });
    fireEvent.change(screen.getByPlaceholderText('Detail for whoever picks it up (optional)'), {
      target: { value: 'start with the sandbox tests' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mocks.addCard).toHaveBeenCalledWith('Triage the flaky suite', 'backlog', {
      body: 'start with the sandbox tests',
    });
  });

  it('omits the detail rather than storing an empty note', async () => {
    renderSection();
    fireEvent.change(await screen.findByPlaceholderText('New card title…'), {
      target: { value: 'Title only' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mocks.addCard).toHaveBeenCalledWith('Title only', 'backlog', { body: undefined });
  });
});
