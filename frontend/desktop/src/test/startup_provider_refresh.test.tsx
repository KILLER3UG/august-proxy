/* Startup provider refresh — one-shot upstream sync when the backend opens. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useStartupProviderRefresh,
  resetStartupRefresh,
} from '@/hooks/useStartupProviderRefresh';
import { providersApi } from '@/api/providers';
import * as catalog from '@/lib/provider-catalog';
import { $gateway } from '@/store/gateway';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useStartupProviderRefresh', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStartupRefresh();
    act(() => $gateway.set({ status: 'connecting' }));
  });

  it('syncs providers once when the gateway opens, then invalidates the catalog', async () => {
    const refreshAll = vi
      .spyOn(providersApi, 'refreshAllModels')
      .mockResolvedValue({ refreshed: 2, failed: 0, added: 3, removed: 1 });
    const invalidate = vi
      .spyOn(catalog, 'refreshProviderCatalog')
      .mockResolvedValue(undefined);

    renderHook(() => useStartupProviderRefresh(), { wrapper });
    expect(refreshAll).not.toHaveBeenCalled();

    act(() => $gateway.set({ status: 'open', port: 8085, uptime: 1 }));

    await waitFor(() => expect(refreshAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    // A backend flap within the same launch must not re-trigger the sync.
    act(() => $gateway.set({ status: 'closed', reason: 'restart' }));
    act(() => $gateway.set({ status: 'open', port: 8085, uptime: 2 }));
    expect(refreshAll).toHaveBeenCalledTimes(1);
  });

  it('fires immediately if the backend is already up at mount', async () => {
    const refreshAll = vi
      .spyOn(providersApi, 'refreshAllModels')
      .mockResolvedValue({ refreshed: 0, failed: 0, added: 0, removed: 0 });
    vi.spyOn(catalog, 'refreshProviderCatalog').mockResolvedValue(undefined);
    act(() => $gateway.set({ status: 'open', port: 8085, uptime: 9 }));

    renderHook(() => useStartupProviderRefresh(), { wrapper });

    await waitFor(() => expect(refreshAll).toHaveBeenCalledTimes(1));
  });

  it('swallows refresh failures so startup never breaks', async () => {
    const refreshAll = vi
      .spyOn(providersApi, 'refreshAllModels')
      .mockRejectedValue(new Error('offline'));
    const invalidate = vi
      .spyOn(catalog, 'refreshProviderCatalog')
      .mockResolvedValue(undefined);

    renderHook(() => useStartupProviderRefresh(), { wrapper });
    act(() => $gateway.set({ status: 'open', port: 8085, uptime: 1 }));

    await waitFor(() => expect(refreshAll).toHaveBeenCalledTimes(1));
    // Let the rejected promise settle — no unhandled rejection, no invalidate.
    await new Promise((r) => setTimeout(r, 0));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
