/* ProviderQuotaConfig — the opt-in contract.
 *
 * Nothing is saved until a URL is typed (no endpoint, no call), the declared
 * kind is json, and the extractors are sent as the user-declared dotted paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Provider } from '@/api/providers';
import { ProviderDetailForm } from '../ProviderDetailForm';

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ updated: true })),
    delete: vi.fn(async () => ({})),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { api } from '@/api/client';

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    name: 'Test OpenAI',
    baseUrl: 'https://api.test/v1',
    apiFormat: 'openaiChat',
    enabled: true,
    apiKeySet: true,
    models: [],
    ...overrides,
  };
}

function renderForm(p: Provider) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProviderDetailForm
        provider={p}
        onChanged={() => {}}
        showAddModel={false}
        setShowAddModel={() => {}}
      />
    </QueryClientProvider>,
  );
}

async function lastPatch() {
  await waitFor(() => expect(vi.mocked(api.patch).mock.calls.length).toBeGreaterThan(0));
  return vi.mocked(api.patch).mock.calls.at(-1)![1] as Record<string, unknown>;
}

describe('ProviderQuotaConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is closed and sends nothing until a URL is declared', async () => {
    renderForm(provider());
    fireEvent.click(screen.getByRole('button', { name: /Quota endpoint/ }));
    // Opening the section must not contact anything by itself.
    expect(vi.mocked(api.patch)).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Quota URL')).toBeInTheDocument();
  });

  it('saves the declared endpoint, kind, and extractor paths', async () => {
    renderForm(provider());
    fireEvent.click(screen.getByRole('button', { name: /Quota endpoint/ }));

    fireEvent.change(screen.getByLabelText('Quota URL'), { target: { value: 'usage' } });
    fireEvent.change(screen.getByLabelText('Limit path'), { target: { value: 'data.quota.limit' } });
    fireEvent.change(screen.getByLabelText('Remaining path'), { target: { value: 'data.quota.remaining' } });
    fireEvent.blur(screen.getByLabelText('Remaining path'));

    const patch = await lastPatch();
    expect(patch.quotaEndpoint).toEqual({
      kind: 'json',
      url: 'usage',
      method: 'GET',
      extract: { limit: 'data.quota.limit', remaining: 'data.quota.remaining', used: '', reset: '' },
    });
    // No auth block declared → null, so August adds no credential.
    expect(patch.quotaAuth).toBeNull();
  });

  it('saves auth as header when the user picks a custom header', async () => {
    renderForm(provider());
    fireEvent.click(screen.getByRole('button', { name: /Quota endpoint/ }));
    fireEvent.change(screen.getByLabelText('Quota URL'), { target: { value: 'https://api.test/usage' } });
    const select = screen.getByDisplayValue('None');
    fireEvent.change(select, { target: { value: 'header' } });
    fireEvent.change(screen.getByLabelText('Quota auth header'), { target: { value: 'x-api-key' } });
    fireEvent.blur(screen.getByLabelText('Quota auth header'));

    const patch = await lastPatch();
    expect(patch.quotaAuth).toEqual({ type: 'header', useProviderKey: true, header: 'x-api-key' });
  });

  it('clears the declaration instead of leaving a half-configured endpoint', async () => {
    renderForm(
      provider({
        quotaEndpoint: { kind: 'json', url: 'usage', extract: { limit: 'data.limit' } },
        quotaAuth: { type: 'bearer' },
      }),
    );
    // A stored endpoint starts expanded so it can be reviewed.
    expect(screen.getByLabelText('Quota URL')).toHaveValue('usage');
    fireEvent.click(screen.getByRole('button', { name: /Clear quota endpoint/ }));
    const patch = await lastPatch();
    expect(patch.quotaEndpoint).toBeNull();
    expect(patch.quotaAuth).toBeNull();
  });
});
