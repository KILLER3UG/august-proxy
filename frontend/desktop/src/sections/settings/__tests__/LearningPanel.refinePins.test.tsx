/* ── LearningPanel refine model pins (UI suggestion 5) ──────────────────── */
/* The gated auto-refine pass has producer + independent-reviewer pins in the
 * backend (`/api/curator/refine/config`); this test pins that the panel
 * exposes them and that selecting a pair posts the right patch. */

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

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/models')) {
      return Promise.resolve({
        models: [
          { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'OpenRouter' },
          { id: 'kilo/gpt-5-mini', name: 'GPT-5 Mini', provider: 'KiloCode' },
        ],
      });
    }
    if (url.startsWith('/api/curator/refine')) {
      return Promise.resolve({
        entries: [],
        config: { autoRefine: true, producerModel: 'kilo/gpt-5-mini', reviewModel: '' },
        ledger: [],
      });
    }
    return Promise.resolve({ mode: 'extract-only', learning: { episodes: 1 }, proposals: [], episodes: [], jobs: [], runs: [] });
  });
  postMock.mockResolvedValue({ ok: true });
});

const renderExpanded = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LearningPanel />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('Learning'));
};

describe('refine model pins', () => {
  it('shows both pickers with the stored producer selected', async () => {
    renderExpanded();
    const producer = (await screen.findByTestId('learning-refine-producer')) as HTMLSelectElement;
    const reviewer = (await screen.findByTestId('learning-refine-reviewer')) as HTMLSelectElement;
    expect(producer.value).toBe('kilo/gpt-5-mini');
    expect(reviewer.value).toBe('');
    // Catalog options come from the aggregated models list.
    expect(Array.from(producer.options).map((o) => o.value)).toContain('anthropic/claude-sonnet-5');
  });

  it('choosing a reviewer posts a config patch with just that field', async () => {
    renderExpanded();
    const reviewer = (await screen.findByTestId('learning-refine-reviewer')) as HTMLSelectElement;
    // The catalog query resolves independently of the refine query — wait
    // for the options to land before changing the select.
    await waitFor(() => expect(reviewer.options.length).toBeGreaterThan(1));
    fireEvent.change(reviewer, { target: { value: 'anthropic/claude-sonnet-5' } });
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/curator/refine/config', {
        reviewModel: 'anthropic/claude-sonnet-5',
      }),
    );
  });
});
