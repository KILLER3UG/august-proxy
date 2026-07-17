/* ── WorkspaceModelsSection regression tests for black-screen bugs ────── */
/* These tests open the View dropdown (not horizontal tabs) and assert that
 * Fallback / Background panels render without a full-viewport overlay.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { WorkspaceModelsSection } from '../WorkspaceModelsSection';

const mockAggregatedModels = {
  models: [
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, isFree: false },
    { id: 'claude-sonnet', name: 'Claude Sonnet', provider: 'anthropic', contextWindow: 200000, isFree: false },
  ],
};

const mockFallbackConfig = {
  config: {
    enabled: false,
    mode: 'session_only',
    provider: '',
    model: '',
  },
};

const mockBackgroundConfig = {
  enabled: false,
  provider: '',
  model: '',
};

let fallbackMock: any = { data: mockFallbackConfig, isLoading: false, isFetching: false };
let backgroundMock: any = { data: mockBackgroundConfig, isLoading: false, isFetching: false };
let modelsMock: any = { data: mockAggregatedModels, isLoading: false };

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (opts: any) => {
      const key = JSON.stringify(opts.queryKey);
      if (key.includes('subagent-fallback-config')) return fallbackMock;
      if (key.includes('review-background-config')) return backgroundMock;
      if (key.includes('aggregated-models')) return modelsMock;
      return { data: null, isLoading: false };
    },
    useMutation: (_opts: any) => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isIdle: true,
      isError: false,
      error: null,
    }),
    useQueryClient: () => ({
      invalidateQueries: vi.fn(),
      refetchQueries: vi.fn(),
    }),
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock('@/lib/provider-catalog', () => ({
  refreshProviderCatalog: vi.fn(() => Promise.resolve(undefined)),
  PROVIDER_CATALOG_QUERY_KEYS: [],
}));

function openView(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Model settings view' }));
  const list = screen.getByRole('listbox');
  fireEvent.click(within(list).getByText(label));
}

beforeEach(() => {
  fallbackMock = { data: mockFallbackConfig, isLoading: false, isFetching: false };
  backgroundMock = { data: mockBackgroundConfig, isLoading: false, isFetching: false };
  modelsMock = { data: mockAggregatedModels, isLoading: false };
});

describe('WorkspaceModelsSection — Fallback subtab', () => {
  it('renders the Fallback subtab without a full-screen overlay', async () => {
    render(<WorkspaceModelsSection />);
    openView('Fallback');

    await waitFor(() => {
      expect(screen.getByText(/sub-agent fallback settings/i)).toBeInTheDocument();
    });

    const overlays = document.querySelectorAll('.fixed.inset-0, [class*="fixed inset-0"]');
    expect(overlays.length).toBe(0);

    const fullScreenCandidates = document.querySelectorAll('[class*="fixed"]');
    for (const el of Array.from(fullScreenCandidates)) {
      const rect = el.getBoundingClientRect();
      const coversViewport = rect.width >= window.innerWidth && rect.height >= window.innerHeight;
      expect(coversViewport).toBe(false);
    }
  });
});

describe('WorkspaceModelsSection — Background & Reflection subtab', () => {
  it('does not render a Provider select/WorkspaceField within the Background panel', async () => {
    render(<WorkspaceModelsSection />);
    openView('Background & Reflection');

    const panel = await screen.findByText(/background review & reflection/i);
    expect(panel).toBeInTheDocument();

    const panelRoot = panel.closest('div.rounded-xl') ?? panel.parentElement ?? document.body;

    const providerLabels = (panelRoot as HTMLElement).querySelectorAll('label');
    const providerLabelMatches = Array.from(providerLabels).filter((l) =>
      /provider/i.test(l.textContent ?? ''),
    );
    expect(providerLabelMatches.length).toBe(0);

    const selects = (panelRoot as HTMLElement).querySelectorAll('select');
    expect(selects.length).toBe(0);
  });
});
