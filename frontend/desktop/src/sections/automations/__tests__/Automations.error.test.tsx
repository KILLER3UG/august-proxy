/* ── Automations: honest failure state ─────────────────────────────────────
 * A failed /api/automations request used to render the "No automations yet"
 * empty card — complete with a "Create automation" CTA, i.e. a 500 read as
 * "you have no jobs, go make one". The error card replaces it, and Retry
 * recovers without touching the backend contract.                          */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getAutomations: vi.fn(),
  listBots: vi.fn().mockResolvedValue({ bots: [] }),
  getAggregatedModels: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/api/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/api-client')>()),
  ...mocks,
}));

vi.mock('@/lib/os-notify', () => ({
  OsNotifyService: { notifyJobComplete: vi.fn() },
}));

vi.mock('@/api/folder', () => ({ openFolderViaTauri: vi.fn() }));

import { Automations } from '../Automations';

configure({ asyncUtilTimeout: 5000 });

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Automations />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Automations — query failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listBots.mockResolvedValue({ bots: [] });
    mocks.getAggregatedModels.mockResolvedValue([]);
  });

  it('shows the failure with a Retry, never the empty state or its create CTA', async () => {
    mocks.getAutomations.mockRejectedValue(new Error('automations: 503 backend unavailable'));
    renderPage();

    const alert = await screen.findByTestId('query-error-state');
    expect(alert.textContent).toContain("Couldn't load automations");
    expect(alert.textContent).toContain('503 backend unavailable');
    // The honest bit: no "nothing here, go create one" copy.
    expect(screen.queryByText('No automations yet.')).toBeNull();
    expect(screen.queryByText('Create automation')).toBeNull();
    // Header must not claim "0 jobs · 0 active".
    expect(screen.queryByText(/0 jobs/)).toBeNull();
  });

  it('Retry re-requests and renders the jobs that were there all along', async () => {
    mocks.getAutomations.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    const alert = await screen.findByTestId('query-error-state');

    mocks.getAutomations.mockResolvedValueOnce({
      jobs: [
        {
          id: 'job-1',
          name: 'Nightly triage',
          jobType: 'workbench',
          schedule: '17 3 * * *',
          prompt: 'Summarize yesterday failures',
        },
      ],
    });
    fireEvent.click(screen.getByTestId('query-error-retry'));

    await waitFor(() => expect(screen.getByText('Nightly triage')).toBeTruthy());
    expect(screen.queryByTestId('query-error-state')).toBeNull();
    expect(alert).toBeDefined();
  });
});
