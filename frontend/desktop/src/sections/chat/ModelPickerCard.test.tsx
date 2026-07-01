/**
 * ModelPickerCard component tests.
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 * Tests the VoiceCommandCardProps-based rewrite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ModelPickerCard } from './ModelPickerCard';

// jsdom doesn't implement scrollIntoView; shim it.
Element.prototype.scrollIntoView = vi.fn();

// Mock useModels.
vi.mock('@/hooks/useModels', () => ({
  useModels: vi.fn(),
}));

import { useModels } from '@/hooks/useModels';

const mockUseModels = useModels as ReturnType<typeof vi.fn>;

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ModelPickerCard sessionId="test" onDismiss={vi.fn()} context={{ currentModelId: '' }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ModelPickerCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading state', () => {
    mockUseModels.mockReturnValue({
      models: [],
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });
    renderCard();
    expect(screen.getByText(/Loading models/i)).toBeDefined();
  });

  it('shows error state', () => {
    mockUseModels.mockReturnValue({
      models: [],
      isLoading: false,
      error: new Error('API error'),
      refetch: vi.fn(),
    });
    renderCard();
    expect(screen.getByText(/Failed to load/i)).toBeDefined();
  });

  it('shows empty state with Settings link when no models', () => {
    mockUseModels.mockReturnValue({
      models: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderCard();
    expect(screen.getByText(/No models available/i)).toBeDefined();
    expect(screen.getByText(/Go to Settings/i)).toBeDefined();
  });

  it('renders the search input and groups models by provider', async () => {
    mockUseModels.mockReturnValue({
      models: [
        { id: 'claude-3', name: 'Claude 3', provider: 'Anthropic', contextWindow: 200000 },
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI', contextWindow: 128000 },
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Anthropic')).toBeDefined();
      expect(screen.getByText('OpenAI')).toBeDefined();
      expect(screen.getByText('Claude 3')).toBeDefined();
      expect(screen.getByText('GPT-4o')).toBeDefined();
    });
    // Search filter narrows results.
    const search = screen.getByPlaceholderText(/Search models/i);
    fireEvent.change(search, { target: { value: 'claude' } });
    await waitFor(() => {
      expect(screen.getByText('Claude 3')).toBeDefined();
      expect(screen.queryByText('GPT-4o')).toBeNull();
    });
  });

  it('emits august:model-selected on click and calls onDismiss', async () => {
    const onDismiss = vi.fn();
    const dispatchSpy = vi.fn();
    window.addEventListener('august:model-selected', dispatchSpy);

    mockUseModels.mockReturnValue({
      models: [
        { id: 'claude-3', name: 'Claude 3', provider: 'Anthropic', contextWindow: 200000 },
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ModelPickerCard sessionId="test" onDismiss={onDismiss} context={{ currentModelId: '' }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Claude 3')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Claude 3'));
    expect(dispatchSpy).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();

    window.removeEventListener('august:model-selected', dispatchSpy);
  });
});
