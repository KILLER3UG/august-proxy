/* Settings → API Access: Inject AUG.md on proxy path toggle */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ExternalAccessSection } from '@/sections/settings/ExternalAccessSection';

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const EXTERNAL = {
  enabled: false,
  hasKey: true,
  keyPreview: 'AUG••••',
  source: 'env',
  endpoints: {
    anthropic: 'http://localhost:8085/v1/messages',
    openai: 'http://localhost:8085/v1/chat/completions',
    models: 'http://localhost:8085/v1/models',
  },
};

describe('Inject AUG.md on proxy path toggle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders off by default and PUTs enabled:true when toggled', async () => {
    let injectEnabled = false;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/config/external-access')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => EXTERNAL,
        });
      }
      if (typeof url === 'string' && url.includes('/api/config/inject-aug-on-proxy')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body || '{}')) as { enabled?: boolean };
          injectEnabled = Boolean(body.enabled);
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ enabled: injectEnabled }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ enabled: injectEnabled }),
        });
      }
      return Promise.reject(new Error('unexpected url: ' + url));
    });
    global.fetch = fetchMock;

    withQuery(<ExternalAccessSection />);

    const toggle = await screen.findByTestId('inject-aug-on-proxy-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/Inject AUG\.md on proxy path/i)).toBeTruthy();

    fireEvent.click(toggle);

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (call) => {
          const [url, init] = call as unknown as [string, RequestInit | undefined];
          return (
            typeof url === 'string' &&
            url.includes('/api/config/inject-aug-on-proxy') &&
            init?.method === 'PUT'
          );
        },
      );
      expect(put).toBeDefined();
      const [, putInit] = put as unknown as [string, RequestInit];
      const body = JSON.parse(String(putInit.body));
      expect(body.enabled).toBe(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId('inject-aug-on-proxy-toggle').getAttribute('aria-checked')).toBe(
        'true',
      );
    });
  });
});
