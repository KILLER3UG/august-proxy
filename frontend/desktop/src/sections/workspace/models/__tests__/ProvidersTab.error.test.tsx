/* ── ProvidersTab: honest failure state ────────────────────────────────────
 * The init effect used to fire on "not loading", which includes a failed
 * catalog request — so a 500 auto-switched the pane into the Add-provider
 * form, as if the install had zero providers. Failure now stays failure.   */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('@/api/providers', () => ({ providersApi: { list: mocks.list } }));
vi.mock('@/lib/provider-catalog', () => ({ refreshProviderCatalog: vi.fn() }));

import { ProvidersTab } from '../ProvidersTab';

configure({ asyncUtilTimeout: 5000 });

const PROVIDER = {
  id: 'p1',
  name: 'OpenCode Zen',
  baseUrl: 'https://opencode.ai/zen',
  apiFormat: 'openaiChat',
  enabled: true,
  models: [],
};

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProvidersTab />
    </QueryClientProvider>,
  );
}

describe('ProvidersTab — catalog query failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the failure, not the auto-opened add form or an empty rail', async () => {
    mocks.list.mockRejectedValue(new Error('providers: 500 boom'));
    renderTab();

    const alert = await screen.findByTestId('query-error-state');
    expect(alert.textContent).toContain("Couldn't load providers");
    expect(alert.textContent).toContain('500 boom');
    // No auto-switch into create mode on a failed read (the rail's
    // "Add provider" chrome button is always there; the form is not).
    expect(screen.queryByText('Add model provider')).toBeNull();
    expect(screen.queryByText('Select a provider or add a new one.')).toBeNull();
    expect(screen.getByTestId('providers-rail-error')).toBeTruthy();
    expect(screen.queryByText('No providers yet')).toBeNull();
  });

  it('Retry re-requests and opens the existing provider', async () => {
    mocks.list.mockRejectedValueOnce(new Error('boom'));
    renderTab();
    await screen.findByTestId('query-error-state');

    mocks.list.mockResolvedValueOnce([PROVIDER]);
    fireEvent.click(screen.getByTestId('query-error-retry'));

    await waitFor(() => expect(screen.getByText('OpenCode Zen')).toBeTruthy());
    expect(screen.queryByTestId('query-error-state')).toBeNull();
    expect(screen.queryByTestId('providers-rail-error')).toBeNull();
  });
});
