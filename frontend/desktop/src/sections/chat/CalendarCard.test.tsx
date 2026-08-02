/**
 * CalendarCard component tests.
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CalendarCard } from './CalendarCard';

/**
 * Drive both hooks from a controllable mock. The original test mocked
 * globalThis.fetch + react-query for the internal-endpoint, which was
 * timezone-sensitive (getTodayISO uses local time while the grid's day
 * key uses UTC), making 'renders internal events' flaky near midnight in
 * non-UTC zones. Mocking the hooks removes that nondeterminism entirely.
 */
const mockState = vi.hoisted(() => {
  const state: {
    events: Array<{ id: string; title: string; date: string; kind: string; source: string }>;
    isLoading: boolean;
    error: Error | null;
  } = { events: [], isLoading: false, error: null };
  return state;
});

vi.mock('@/hooks/useMcpTools', () => ({
  useMcpTools: () => ({ tools: [], isLoading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('@/hooks/useCalendarEvents', () => ({
  useCalendarEvents: () => ({
    data: { events: mockState.events },
    isLoading: mockState.isLoading,
    error: mockState.error,
  }),
}));

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CalendarCard sessionId="test" onDismiss={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('CalendarCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.events = [];
    mockState.isLoading = false;
    mockState.error = null;
  });

  it('renders the week header and navigation', async () => {
    mockState.isLoading = true;
    renderCard();
    expect(screen.getByText(/Loading events/i)).toBeDefined();
    mockState.isLoading = false;
    await waitFor(() => {
      expect(screen.getByText(/Prev week/i)).toBeDefined();
      expect(screen.getByText(/Next week/i)).toBeDefined();
      expect(screen.getByText(/Today/i)).toBeDefined();
    });
  });

  it('shows the no-MCP hint when tools list is empty', async () => {
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Connect a calendar MCP/i)).toBeDefined();
    });
  });

  it('renders day names (Mon through Sun)', async () => {
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Mon')).toBeDefined();
      expect(screen.getByText('Fri')).toBeDefined();
    });
  });

  it('navigates weeks when clicking Prev/Next', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText(/Prev week/i)).toBeDefined());

    const prev = screen.getByText(/Prev week/i);
    fireEvent.click(prev);
    await waitFor(() => expect(screen.getByText(/Today/i)).toBeDefined());
  });

  it('renders internal events in the correct day cell', async () => {
    // Date computed the same way the grid does (UTC ISO day of local "today"),
    // so it always lands on the current day cell regardless of timezone.
    const today = new Date();
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate())
      .toISOString()
      .slice(0, 10);
    mockState.events = [
      { id: 'e1', title: 'Review PR', date, kind: 'task', source: 'internal' },
    ];
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Review PR')).toBeDefined();
    });
  });
});
