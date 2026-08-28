import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Bug 1: deleting the ACTIVE chat when no other chat exists used to strand the
// router on the dead /c/<id> route (white screen). The fix navigates to '/'.

vi.mock('@/api/workbench', () => ({
  deleteWorkbenchSession: vi.fn().mockResolvedValue(undefined),
  stopWorkbenchChat: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/api/api-client', () => ({
  deleteManageSession: vi.fn().mockResolvedValue(undefined),
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

function seedSession(id: string, title = 'Only chat'): Session {
  return {
    id,
    title,
    startedAt: new Date().toISOString(),
    messageCount: 1,
    lastMessage: 'hi',
    provider: 'openai',
    model: 'gpt',
  };
}

/** Click the overflow ("More options") button on the row showing `title`. */
function openRowMenu(title: string) {
  const row = screen.getByText(title).closest('.august-session-row');
  if (!row) throw new Error(`row not found for ${title}`);
  fireEvent.click(within(row as HTMLElement).getByLabelText('More options'));
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

describe('SessionList — delete-active fallback (Bug 1)', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], folders: [], sessionStates: {} });
    // Expand the "Other chats" group so unfiled session rows render.
    localStorage.setItem('august-uncategorized-collapsed', '0');
  });

  it('navigates home when the only (active) chat is deleted', async () => {
    const s = seedSession('sess_only', 'Solo chat');
    useSessionsStore.setState({ sessions: [s] });
    const onNavigate = vi.fn();
    const onSelect = vi.fn();

    render(
      <SessionList
        activeId={s.id}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onSelect={onSelect}
        onNew={vi.fn()}
        onNavigate={onNavigate}
      />,
      { wrapper },
    );

    // Open the row overflow menu, choose Delete Chat, confirm.
    await openRowMenu('Solo chat');
    fireEvent.click(await screen.findByText('Delete Chat'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('/');
    });
    // No fallback session existed, so onSelect must NOT have been used.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects a surviving chat instead of navigating home', async () => {
    const active = seedSession('sess_active', 'Active chat');
    const other = seedSession('sess_other', 'Other chat');
    useSessionsStore.setState({ sessions: [active, other] });
    const onNavigate = vi.fn();
    const onSelect = vi.fn();

    render(
      <SessionList
        activeId={active.id}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onSelect={onSelect}
        onNew={vi.fn()}
        onNavigate={onNavigate}
      />,
      { wrapper },
    );

    await openRowMenu('Active chat');
    fireEvent.click(await screen.findByText('Delete Chat'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sess_other' }),
      );
    });
    expect(onNavigate).not.toHaveBeenCalledWith('/');
  });
});
