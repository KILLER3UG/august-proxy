import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// The pool of sessions is unbounded — they accumulate in localStorage and
// nothing prunes them — while every row is a framer-motion node with its own
// handlers. The group renders the newest 60 and says so; it must not silently
// drop rows, and it must not mount a long history on first paint.

vi.mock('@/api/workbench', () => ({
  deleteWorkbenchSession: vi.fn().mockResolvedValue(undefined),
  stopWorkbenchChat: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/api/api-client', () => ({
  deleteManageSession: vi.fn().mockResolvedValue(undefined),
  listBots: vi.fn().mockResolvedValue({ bots: [] }),
  ensureBotChat: vi.fn(),
  createBot: vi.fn(),
  deleteBot: vi.fn(),
  updateBotUiMeta: vi.fn(),
}));
vi.mock('@/hooks/useAppUpdate', () => ({
  useAppUpdate: () => ({ available: false }),
}));
vi.mock('@/store/chat-active-streams', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/store/chat-active-streams')>();
  return { ...actual, startChatActiveStreamsPoller: vi.fn() };
});

import { SessionList } from '../SessionList';
import { useSessionsStore, type Session } from '@/store/sessions';

function seedMany(count: number): Session[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sess_${i}`,
    // Title rises with age, so `Chat ${count}` is the newest row and `Chat 1`
    // the oldest — which of the two survives the cap is then unambiguous.
    title: `Chat ${i + 1}`,
    startedAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
    messageCount: 1,
    lastMessage: 'hi',
    provider: 'openai',
    model: 'gpt',
  }));
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

function renderList() {
  return render(
    <SessionList
      collapsed={false}
      onToggleCollapsed={vi.fn()}
      onSelect={vi.fn()}
      onNew={vi.fn()}
      onNavigate={vi.fn()}
    />,
    { wrapper },
  );
}

describe('SessionList — bounded group rendering', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], folders: [], sessionStates: {} });
    localStorage.setItem('august-uncategorized-collapsed', '0');
  });

  it('renders the newest 60 unfiled rows and reports the rest as a subset', () => {
    useSessionsStore.setState({ sessions: seedMany(90) });
    renderList();

    expect(document.querySelectorAll('.august-session-row')).toHaveLength(60);
    // Two captions here — the Projects summary and the unfiled group — and both
    // must admit the same subset. A "shown/total" that only the inner group
    // carried would leave the header claiming 90 rows that are not mounted.
    const captions = screen.getAllByTestId('group-shown-of-total');
    expect(captions).toHaveLength(2);
    for (const caption of captions) expect(caption.textContent).toBe('60/90');
    // What is held back is the OLDEST: the newest row is on screen, the oldest
    // is not, and nothing about the count is hidden.
    expect(screen.queryByText('Chat 1')).toBeNull();
    expect(screen.getByText('Chat 90')).toBeTruthy();
  });

  it('renders every row and no caption while the group fits under the cap', () => {
    useSessionsStore.setState({ sessions: seedMany(5) });
    renderList();

    expect(document.querySelectorAll('.august-session-row')).toHaveLength(5);
    expect(screen.queryByTestId('group-shown-of-total')).toBeNull();
  });
});
