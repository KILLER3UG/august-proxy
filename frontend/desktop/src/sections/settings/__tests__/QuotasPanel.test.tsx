/* QuotasPanel — the truthfulness contract in the UI.
 *
 * A native row may only show a cap the provider stated; a local row must show
 * no cap at all, because August has no idea what a provider's ceiling is.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ModelQuota } from '@/api/quota';
import { QuotasPanel } from '../QuotasPanel';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(async () => ({ results: [] })) },
}));

import { api } from '@/api/client';

function row(overrides: Partial<ModelQuota> = {}): ModelQuota {
  return {
    provider: 'Test OpenAI',
    model: 'gpt-4o-mini',
    used: 0,
    prompt: 0,
    completion: 0,
    limit: null,
    remaining: null,
    nativeUsed: null,
    percent: 0,
    resetsAt: null,
    observedAt: null,
    source: 'local',
    ...overrides,
  };
}

function renderPanel(quotas: ModelQuota[]) {
  vi.mocked(api.get).mockResolvedValue({
    results: [{ provider: 'Test OpenAI', quotas }],
  } as never);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <QuotasPanel />
    </QueryClientProvider>,
  );
}

describe('QuotasPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a local row with no cap when the provider stated nothing', async () => {
    renderPanel([row({ used: 12_500, prompt: 10_000, completion: 2_500 })]);
    await waitFor(() => expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument());
    expect(screen.getByText('local')).toBeInTheDocument();
    // Spend only — no fabricated ceiling, and no bar to imply one.
    expect(screen.getByText('12.5K')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText(/Local estimate/)).toBeInTheDocument();
  });

  it('shows the provider-stated cap, remaining-derived usage, and reset time', async () => {
    renderPanel([
      row({
        source: 'native',
        limit: 10_000,
        remaining: 2_500,
        nativeUsed: 7_500,
        percent: 75,
        resetsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        observedAt: new Date().toISOString(),
      }),
    ]);
    await waitFor(() => expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument());
    expect(screen.getByText('native')).toBeInTheDocument();
    expect(screen.getByText('7.5K / 10.0K (75.0%)')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '75');
    expect(screen.getByText(/Reported by provider/)).toBeInTheDocument();
    expect(screen.getByText(/resets in/)).toBeInTheDocument();
  });

  it('never prints August spend as the provider-side consumed amount', async () => {
    // local `used` counts August's own window; `nativeUsed` counts the
    // provider's. A native row must show the provider's number.
    renderPanel([
      row({
        source: 'native',
        used: 999_999,
        limit: 1000,
        nativeUsed: 100,
        remaining: 900,
        percent: 10,
      }),
    ]);
    await waitFor(() => expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument());
    expect(screen.getByText('100 / 1.0K (10.0%)')).toBeInTheDocument();
  });

  it('labels an account-level (model-less) native row without naming a model', async () => {
    renderPanel([
      row({ model: '', source: 'native', limit: 500, nativeUsed: 100, remaining: 400, percent: 20 }),
    ]);
    await waitFor(() => expect(screen.getByText('account')).toBeInTheDocument());
  });

  it('counts provider-reported rows in the provider header', async () => {
    renderPanel([
      row({ model: 'a', source: 'native', limit: 10, nativeUsed: 1, remaining: 9, percent: 10 }),
      row({ model: 'b', used: 42 }),
    ]);
    await waitFor(() => expect(screen.getByText(/1 provider-reported/)).toBeInTheDocument());
  });
});
