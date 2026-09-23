import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/store/sessions', () => ({
  useSessionsStore: (select: (state: { sessions: unknown[] }) => unknown) =>
    select({
      sessions: [
        {
          id: 'history-session',
          title: 'Visible history item',
          startedAt: new Date().toISOString(),
          messageCount: 2,
          lastMessage: 'Last message',
          model: 'test-model',
          provider: 'test-provider',
        },
      ],
    }),
  deleteSession: mocks.deleteSession,
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

import { HistoryPage } from '../HistoryPage';

describe('HistoryPage — keyboard and visibility accessibility', () => {
  beforeEach(() => {
    mocks.deleteSession.mockClear();
  });

  it('keeps the destructive action visible and focusable without hover', () => {
    render(<HistoryPage />);

    const deleteButton = screen.getByLabelText('Delete Visible history item conversation');
    expect(deleteButton.className).toContain('opacity-100');
    expect(deleteButton.className).not.toContain('opacity-0');
    expect(deleteButton.className).toContain('focus-visible:ring-2');
    expect(deleteButton).toBeVisible();
  });

  it('requires an explicit confirmation before the transcript is destroyed', async () => {
    render(<HistoryPage />);

    fireEvent.click(screen.getByLabelText('Delete Visible history item conversation'));

    // One click must not delete: the row sits directly under the open action.
    expect(mocks.deleteSession).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Delete this conversation?'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // The delete is behind an awaited confirm(), so it lands a microtask later.
    await waitFor(() => expect(mocks.deleteSession).toHaveBeenCalledWith('history-session'));
  });

  it('leaves the session intact when the confirmation is cancelled', async () => {
    render(<HistoryPage />);

    fireEvent.click(screen.getByLabelText('Delete Visible history item conversation'));
    // The cancel button carries an "Esc" hint inside its label, so match the
    // prefix rather than the whole accessible name.
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel/ }));

    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });
});
