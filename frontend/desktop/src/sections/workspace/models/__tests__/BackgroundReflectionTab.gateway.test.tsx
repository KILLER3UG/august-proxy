import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BackgroundReflectionTab } from '../BackgroundReflectionTab';

// `dup-model` is served by two gateways in the same catalog. A selector that
// stores only the model id cannot say which one it means, and resolution answers
// with the first provider that lists the id — OpenRouter here, KiloCode when the
// user configured KiloCode.

const CONFIG = {
  enabled: true,
  reviewModel: 'dup-model',
  reviewModelProvider: 'KiloCode',
  reflectionModel: '',
  reflectionModelProvider: '',
  autoMemoryModel: '',
  autoMemoryModelProvider: '',
};

const CATALOG = {
  models: [
    { id: 'dup-model', name: 'Dup Model', provider: 'OpenRouter', contextWindow: 128000 },
    { id: 'dup-model', name: 'Dup Model', provider: 'KiloCode', contextWindow: 128000 },
  ],
  total: 2,
};

function mockFetch() {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/config/background-review') && init?.method === 'PUT') {
      return Promise.resolve({ ok: true, status: 200, json: () => CONFIG });
    }
    if (url.includes('/api/config/background-review')) {
      return Promise.resolve({ ok: true, json: () => CONFIG });
    }
    if (url.includes('/api/models')) {
      return Promise.resolve({ ok: true, json: () => CATALOG });
    }
    return Promise.reject(new Error('unexpected url: ' + url));
  });
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

describe('BackgroundReflectionTab — a selector names its gateway', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('badges the configured gateway, not the first provider listing the id', async () => {
    global.fetch = mockFetch();
    render(<BackgroundReflectionTab />, { wrapper });
    await waitFor(() => screen.getByText('Review model'));
    expect(screen.getAllByText('KiloCode')).toHaveLength(1);
    // The list is closed, so OpenRouter appears nowhere: the picker resolved the
    // stored id to the gateway the config named.
    expect(screen.queryByText('OpenRouter')).toBeNull();
  });

  it('PUTs the gateway with the model when one is picked', async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock;
    render(<BackgroundReflectionTab />, { wrapper });
    await waitFor(() => screen.getByText('Reflection model'));

    // The reflection and auto-memory triggers are still empty, so they read
    // "Select model"; the first of them is reflection.
    const emptyTriggers = screen
      .getAllByText('Select model')
      .map((el) => el.closest('button'))
      .filter((el): el is HTMLButtonElement => el !== null);
    expect(emptyTriggers.length).toBe(2);
    fireEvent.click(emptyTriggers[0]);
    const rows = await screen.findAllByText('Dup Model');
    // Both gateways are offered — the catalog used to be de-duped by id, which
    // made the second one impossible to choose.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(rows[rows.length - 1]);

    await waitFor(() => {
      expect(screen.getByText('Save')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u).includes('/api/config/background-review') &&
          (init as RequestInit | undefined)?.method === 'PUT',
      );
      if (!call) throw new Error('no PUT to background-review');
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.reflectionModel).toBe('dup-model');
      expect(body.reflectionModelProvider).toBeTruthy();
    });
  });
});
