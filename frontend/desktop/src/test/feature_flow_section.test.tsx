/* Feature Flow section — inventory directory + empty-state smoke */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FeatureFlowSection } from '@/sections/settings/FeatureFlowSection';

vi.mock('@/api/api-client', () => ({
  getFeatureInventory: vi.fn(async () => ({
    count: 2,
    features: [
      {
        id: 'proxy',
        name: 'Multi-provider proxy',
        description: 'Translation and routing',
        stages: ['start', 'route', 'upstream', 'end'],
      },
      {
        id: 'tools',
        name: 'Tools',
        description: 'Tool execution',
        stages: ['start', 'exec', 'end'],
      },
    ],
  })),
  getFeatureFlowEvents: vi.fn(async () => [
    {
      id: 'e1',
      traceId: 'tr-1',
      feature: 'proxy',
      stage: 'start',
      status: 'running',
      summary: 'Proxy hop started',
      error: null,
      durationMs: null,
      meta: {},
      at: new Date().toISOString(),
    },
  ]),
  openFeatureFlowEventStream: vi.fn(() => {
    const es = {
      onmessage: null as ((ev: MessageEvent) => void) | null,
      close: vi.fn(),
    };
    return es as unknown as EventSource;
  }),
}));

function withQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('FeatureFlowSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders inventory directory and pipeline stages', async () => {
    withQuery(<FeatureFlowSection />);
    await waitFor(() => {
      expect(screen.getByTestId('feature-inventory-directory')).toBeTruthy();
    });
    expect(screen.getByTestId('feature-inv-proxy')).toBeTruthy();
    expect(screen.getByTestId('feature-flow-trace')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('feature-flow-feed')).toBeTruthy();
    });
    expect(screen.getByText(/Proxy hop started/i)).toBeTruthy();
  });
});
