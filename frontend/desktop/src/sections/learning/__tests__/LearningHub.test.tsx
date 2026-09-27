/* ── LearningHub (/learning) — the four-tab rail, reusing the real panels ──
 * The hub is additive: it renders the EXISTING Settings sections rather than
 * copies, so this test is really a wiring test — four rail rows, the pending
 * count on the Inbox row, and each row mounting the section it claims. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

import { api } from '@/api/client';
import { LearningHub } from '../LearningHub';

const getMock = vi.mocked(api.get);

function mockRoutes(routes: Record<string, unknown>) {
  getMock.mockImplementation((url: string) => {
    for (const [k, v] of Object.entries(routes)) {
      if (url.startsWith(k)) return Promise.resolve(v);
    }
    return Promise.resolve({});
  });
}

const renderHub = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LearningHub />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRoutes({
    '/api/harness/proposals/inbox/count': { harness: 2, memory: 1, total: 3 },
    '/api/harness/proposals': { proposals: [], openCount: 0 },
    '/api/august/memory/proposals': { ok: true, proposals: [] },
    '/api/skills': { skills: [] },
    '/api/curator/report': { mode: 'extract-only', learning: { episodes: 2 } },
    '/api/curator/scheduler': { jobs: [], runs: [] },
    '/api/curator/refine': { entries: [], config: { autoRefine: false }, ledger: [] },
    '/api/brain/stores': { stores: [] },
  });
});

describe('LearningHub', () => {
  it('offers exactly the four learning tabs on a vertical rail', () => {
    renderHub();
    const rail = screen.getByRole('navigation', { name: 'Learning sections' });
    expect(rail).toBeTruthy();
    for (const label of ['Inbox', 'Skills', 'Memory', 'Scheduler']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
  });

  it('badges the Inbox row with the pending-decision count', async () => {
    renderHub();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Inbox/ }).textContent).toContain('3'),
    );
  });

  it('opens on the review inbox, then mounts the section each tab claims', async () => {
    renderHub();

    // Inbox is the default view — the decision queue is why you came here.
    expect(await screen.findByRole('heading', { name: /Review Inbox/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Skills/ }));
    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Memory/ }));
    expect(await screen.findByTestId('memory-group-global')).toBeTruthy();

    // The scheduler tab is the learning panel, open on arrival: the job
    // ledger is inside it, so a collapsed card would show nothing.
    fireEvent.click(screen.getByRole('button', { name: /^Scheduler/ }));
    expect(await screen.findByTestId('learning-scheduler')).toBeTruthy();
  });
});
