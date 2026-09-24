/* ── WorkspaceUsageSection: honest failure state ───────────────────────────
 * Every usage panel answered a failed request with a zero or an "idle"
 * reading, so a dropped backend looked like a perfectly unused install. A
 * panel with no data and an error now says so.                            */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  heatmap: vi.fn(),
  byModel: vi.fn(),
  byDay: vi.fn(),
}));

vi.mock('@/api/usage', () => ({
  usageApi: {
    stats: mocks.stats,
    heatmap: mocks.heatmap,
    byModel: mocks.byModel,
    byDay: mocks.byDay,
  },
}));

// The chart components are not what these tests are about; keep jsdom happy.
vi.mock('@/components/workspace/WorkspaceHeatmap', () => ({ WorkspaceHeatmap: () => <div data-testid="heatmap" /> }));
vi.mock('@/components/workspace/WorkspaceTrendChart', () => ({ WorkspaceTrendChart: () => <div data-testid="trend" /> }));
vi.mock('@/components/workspace/WorkspaceDonut', () => ({ WorkspaceDonut: () => <div data-testid="donut" /> }));

import { WorkspaceUsageSection } from '../WorkspaceUsageSection';

configure({ asyncUtilTimeout: 5000 });

const STATS = {
  range: '7d',
  totalTokens: 4200,
  peakTokens: 900,
  sessions: 3,
  messages: 12,
  activeDays: 2,
  currentStreak: 1,
  longestStreak: 4,
  favoriteModel: 'deepseek-chat',
  favoriteModelShare: 0.6,
  at: new Date().toISOString(),
};

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceUsageSection />
    </QueryClientProvider>,
  );
}

describe('WorkspaceUsageSection — query failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.heatmap.mockResolvedValue({ results: [] });
    mocks.byModel.mockResolvedValue({ results: [] });
    mocks.byDay.mockResolvedValue({ results: [] });
  });

  it('withholds the metric cards when the stats read failed', async () => {
    mocks.stats.mockRejectedValue(new Error('usage stats: 500 boom'));
    renderSection();

    const alert = await screen.findByTestId('query-error-state');
    expect(alert.textContent).toContain("Couldn't load usage stats");
    expect(alert.textContent).toContain('500 boom');
    // Zeros would read as a real measurement; the panel is withheld instead.
    expect(screen.queryByText('Total tokens')).toBeNull();
    expect(screen.queryByText('Longest streak')).toBeNull();
  });

  it('Retry re-requests and the real numbers come back', async () => {
    mocks.stats.mockRejectedValueOnce(new Error('boom'));
    renderSection();
    await screen.findByTestId('query-error-state');

    mocks.stats.mockResolvedValueOnce(STATS);
    fireEvent.click(screen.getByTestId('query-error-retry'));

    await waitFor(() => expect(screen.getByText('Total tokens')).toBeTruthy());
    expect(screen.getByText('4.2K')).toBeTruthy();
    expect(screen.queryByTestId('query-error-state')).toBeNull();
  });

  it('a failed heatmap read says so instead of an empty grid', async () => {
    mocks.stats.mockResolvedValue(STATS);
    mocks.heatmap.mockRejectedValue(new Error('heatmap: 502 boom'));
    renderSection();

    await waitFor(() => expect(screen.getByText("Couldn't load token activity")).toBeTruthy());
    expect(screen.queryByTestId('heatmap')).toBeNull();
    // The headline metrics still render — only that panel failed.
    expect(screen.getByText('Total tokens')).toBeTruthy();
  });
});
