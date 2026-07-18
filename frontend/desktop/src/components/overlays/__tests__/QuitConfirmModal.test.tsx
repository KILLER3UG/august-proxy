import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { QuitConfirmModal } from '../QuitConfirmModal';
import { useSessionsStore } from '@/store/sessions';
import { useActiveChatStreamsStore } from '@/store/chat-active-streams';

const listenHandlers: Array<(event: unknown) => void> = [];
const invokeMock = vi.fn();

vi.mock('@/lib/tauri-detect', () => ({
  isTauri: true,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: unknown) => void) => {
    listenHandlers.push(handler);
    return () => {
      const idx = listenHandlers.indexOf(handler);
      if (idx >= 0) listenHandlers.splice(idx, 1);
    };
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe('QuitConfirmModal', () => {
  beforeEach(() => {
    listenHandlers.length = 0;
    invokeMock.mockReset();
    useSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          title: 'August project app version',
          startedAt: new Date().toISOString(),
          messageCount: 1,
          lastMessage: '',
          provider: 'test',
          model: 'grok',
        },
        {
          id: 's2',
          title: 'Idle chat',
          startedAt: new Date().toISOString(),
          messageCount: 0,
          lastMessage: '',
          provider: 'test',
          model: 'grok',
        },
      ],
      folders: [],
      sessionStates: { s1: 'working' },
    });
    useActiveChatStreamsStore.setState({ active: {} });
  });

  it('lists active sessions when quit is requested', async () => {
    render(<QuitConfirmModal />);
    await waitFor(() => expect(listenHandlers.length).toBeGreaterThan(0));

    act(() => {
      listenHandlers[0]?.({});
    });

    expect(screen.getByTestId('quit-confirm-modal')).toBeInTheDocument();
    expect(screen.getByText('Agent is still working')).toBeInTheDocument();
    expect(screen.getByTestId('quit-active-sessions')).toHaveTextContent(
      'August project app version',
    );
    expect(screen.queryByText('Idle chat')).not.toBeInTheDocument();
  });

  it('shows simple confirm when no sessions are active', async () => {
    useSessionsStore.setState({ sessionStates: {} });
    render(<QuitConfirmModal />);
    await waitFor(() => expect(listenHandlers.length).toBeGreaterThan(0));

    act(() => {
      listenHandlers[0]?.({});
    });

    expect(screen.getByText('Quit August?')).toBeInTheDocument();
    expect(screen.queryByTestId('quit-active-sessions')).not.toBeInTheDocument();
  });

  it('Cancel closes without invoking confirm_quit', async () => {
    render(<QuitConfirmModal />);
    await waitFor(() => expect(listenHandlers.length).toBeGreaterThan(0));
    act(() => {
      listenHandlers[0]?.({});
    });

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByTestId('quit-confirm-modal')).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('Quit Anyway invokes confirm_quit', async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<QuitConfirmModal />);
    await waitFor(() => expect(listenHandlers.length).toBeGreaterThan(0));
    act(() => {
      listenHandlers[0]?.({});
    });

    fireEvent.click(screen.getByTestId('quit-anyway-btn'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('confirm_quit');
    });
  });
});
