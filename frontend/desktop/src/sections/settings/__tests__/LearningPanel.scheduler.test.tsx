/* ── LearningPanel: scheduler + refine status (P2) ──────────────────────── */
/* The panel is the only surface that proves the background learning writers
 * are alive: cadence, last run, and the refine verdict of the last
 * consolidation pass must render from /api/curator/scheduler, and "run now"
 * must hit the ledger-backed job route. Before this section shipped, a 24h
 * refine pass looked dead in the UI between runs. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

import { api } from '@/api/client';
import { LearningPanel } from '../LearningPanel';

const getMock = vi.mocked(api.get);
const postMock = vi.mocked(api.post);

function mockRoutes(routes: Record<string, unknown>) {
  getMock.mockImplementation((url: string) => {
    for (const [k, v] of Object.entries(routes)) {
      if (url.startsWith(k)) return Promise.resolve(v);
    }
    return Promise.resolve({});
  });
}

const renderPanel = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LearningPanel />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRoutes({
    '/api/curator/report': { mode: 'extract-only', learning: { episodes: 4 } },
    '/api/curator/refine': { entries: [], config: { autoRefine: true }, ledger: [] },
    '/api/curator/episodes': { episodes: [] },
    '/api/harness/proposals': { proposals: [] },
    '/api/curator/scheduler': {
      jobs: [
        {
          job: 'introspection',
          intervalHours: 6,
          lastRunAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          lastStatus: 'ok',
          lastDurationS: 1.2,
          nextDueAt: null,
          summary: { observationsFiled: 2, promotionsFiled: 1 },
        },
        {
          job: 'consolidation',
          intervalHours: 24,
          lastRunAt: new Date(Date.now() - 20 * 3_600_000).toISOString(),
          lastStatus: 'ok',
          lastDurationS: 30,
          nextDueAt: null,
          summary: { refine: { status: 'kept', applied: 3 } },
        },
      ],
      runs: [],
    },
  });
});

describe('LearningPanel scheduler section', () => {
  it('renders cadence, last-run age, and outcome phrases after expand', async () => {
    renderPanel();
    fireEvent.click(screen.getByText('Learning'));

    const intro = await screen.findByTestId('learning-scheduler-job-introspection');
    expect(intro.textContent).toContain('every 6h');
    expect(intro.textContent).toContain('3h ago');
    expect(intro.textContent).toContain('2 observation(s) filed');
    expect(intro.textContent).toContain('1 promotion(s) filed');

    const cons = screen.getByTestId('learning-scheduler-job-consolidation');
    expect(cons.textContent).toContain('every 24h');
    expect(cons.textContent).toContain('20h ago');
    // UI suggestion 6: the refine verdict of the last pass is visible inline.
    expect(cons.textContent).toContain('refine: kept (3 applied)');
  });

  it('run now posts to the scheduler job route', async () => {
    postMock.mockResolvedValue({ ok: true, job: 'introspection', status: 'ok' });
    renderPanel();
    fireEvent.click(screen.getByText('Learning'));

    const btn = await screen.findByTestId('learning-scheduler-run-consolidation');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/curator/scheduler/run/consolidation'),
    );
  });

  it('a never-run job shows "never" and an errored job is marked', async () => {
    mockRoutes({
      '/api/curator/scheduler': {
        jobs: [
          { job: 'introspection', intervalHours: 6, lastRunAt: null, lastStatus: 'never', lastDurationS: null, nextDueAt: null, summary: {} },
          { job: 'consolidation', intervalHours: 24, lastRunAt: '2026-09-09T00:00:00+00:00', lastStatus: 'error', lastDurationS: 2, nextDueAt: null, summary: { error: 'boom' } },
        ],
        runs: [],
      },
    });
    renderPanel();
    fireEvent.click(screen.getByText('Learning'));

    const intro = await screen.findByTestId('learning-scheduler-job-introspection');
    expect(intro.textContent).toContain('never');
    const cons = screen.getByTestId('learning-scheduler-job-consolidation');
    expect(cons.textContent).toContain('errored');
  });
});
