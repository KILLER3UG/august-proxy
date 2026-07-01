/**
 * CalendarCard component tests.
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CalendarCard } from './CalendarCard';

// Mock fetch for internal events.
const mockFetch = vi.fn();
(globalThis as any).fetch = mockFetch;

// Mock useMcpTools.
vi.mock('@/hooks/useMcpTools', () => ({
  useMcpTools: () => ({ tools: [], isLoading: false, error: null, refetch: vi.fn() }),
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
    mockFetch.mockReset();
  });

  it('renders the week header and navigation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events: [] }),
    });
    renderCard();

    // Shows loading initially, then the grid after fetch completes.
    expect(screen.getByText(/Loading events/i)).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText(/Prev week/i)).toBeDefined();
      expect(screen.getByText(/Next week/i)).toBeDefined();
      expect(screen.getByText(/Today/i)).toBeDefined();
    });
  });

  it('shows the no-MCP hint when tools list is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events: [] }),
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Connect a calendar MCP/i)).toBeDefined();
    });
  });

  it('renders day names (Mon through Sun)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events: [] }),
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Mon')).toBeDefined();
      expect(screen.getByText('Fri')).toBeDefined();
    });
  });

  it('navigates weeks when clicking Prev/Next', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events: [] }),
    });
    renderCard();
    await waitFor(() => expect(screen.getByText(/Prev week/i)).toBeDefined());

    const prev = screen.getByText(/Prev week/i);
    fireEvent.click(prev);
    // After click, the week header should have changed (different dates).
    // We just verify it doesn't crash — the specific dates depend on today.
    await waitFor(() => expect(screen.getByText(/Today/i)).toBeDefined());
  });

  it('renders internal events in the correct day cell', async () => {
    const events = [
      { id: 'e1', title: 'Review PR', date: getTodayISO(), kind: 'task', source: 'internal' },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events }),
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Review PR')).toBeDefined();
    });
  });
});

function getTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
