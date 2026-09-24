/* ── Runs: honest failure state ────────────────────────────────────────────
 * /api/workbench/sessions failing used to render "No runs yet" plus a stat
 * strip of real-looking zeroes (0 runs, $0). Both are claims about data the
 * app never received. The failure card replaces them; Retry recovers.      */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/api/client', () => ({ api: { get: mocks.get } }));
vi.mock('@/api/workbench', () => ({ getWorkbenchSession: vi.fn() }));
vi.mock('@/sections/chat/chat-stream-manager', () => ({
  startChatStream: vi.fn(),
  stopChatStream: vi.fn(),
  getOrInitSessionStreamState: () => ({ messages: [] }),
  resolveUiSessionId: (id: string) => id,
}));

import { RunsPage } from '../RunsPage';

configure({ asyncUtilTimeout: 5000 });

const RUN = {
  id: 'wb_1',
  title: 'Refactor parser',
  provider: 'deepseek',
  model: 'deepseek-chat',
  agentId: '',
  messageCount: 4,
  mutationCount: 0,
  turnCount: 2,
  status: 'idle',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  totalInputTokens: 1200,
  totalOutputTokens: 300,
  totalCost: 0.01,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RunsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunsPage — query failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the failure instead of "No runs yet" and hides the zeroed stat strip', async () => {
    mocks.get.mockRejectedValue(new Error('workbench sessions: 502 bad gateway'));
    renderPage();

    const alert = await screen.findByTestId('query-error-state');
    expect(alert.textContent).toContain("Couldn't load runs");
    expect(alert.textContent).toContain('502 bad gateway');
    expect(screen.queryByText(/No runs yet/)).toBeNull();
    // A failed read must not be dressed up as a real measurement.
    expect(screen.queryByText('Total runs')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('Retry re-requests and renders the run that existed all along', async () => {
    mocks.get.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await screen.findByTestId('query-error-state');

    mocks.get.mockResolvedValueOnce([RUN]);
    fireEvent.click(screen.getByTestId('query-error-retry'));

    await waitFor(() => expect(screen.getByTestId('run-row-wb_1')).toBeTruthy());
    expect(screen.queryByTestId('query-error-state')).toBeNull();
    expect(screen.getByText('Total runs')).toBeTruthy();
  });
});
