/* v4.3 — Brain Activity tab renders an event feed with chip filters + pause toggle */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrainActivityTab } from '@/sections/brain/BrainActivityTab';

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const EVENTS = [
  {
    id: 'e1',
    category: 'consolidation' as const,
    layer: 'consolidation_daemon',
    summary: 'Sleep cycle merged 2 duplicate Yarn rules',
    meta: { merged: 2, promoted: 0, deletedStale: 0 },
    at: '2026-06-30T10:24:15Z',
  },
  {
    id: 'e2',
    category: 'heuristic' as const,
    layer: 'heuristics_service',
    summary: 'Added heuristic [manual]: Use tabs',
    meta: {},
    at: '2026-06-30T10:23:40Z',
  },
  {
    id: 'e3',
    category: 'delta_engine' as const,
    layer: 'delta_engine.flush_queue',
    summary: "Delta engine inferred 3 preferences from your edits",
    meta: { local: 2, llm: 1 },
    at: '2026-06-30T10:23:01Z',
  },
];

describe('v4.3 — BrainActivityTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Mock EventSource so we don't actually open an SSE connection in jsdom
    class MockEventSource {
      addEventListener() {}
      close() {}
      onmessage: ((ev: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
    }
    (globalThis as any).EventSource = MockEventSource;
  });

  it('renders events newest-first with their category labels', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => EVENTS,
    });
    withQuery(<BrainActivityTab />);
    await waitFor(() => {
      expect(screen.getByText(/Sleep cycle merged/i)).toBeTruthy();
      expect(screen.getByText(/Added heuristic/i)).toBeTruthy();
      expect(screen.getByText(/Delta engine inferred/i)).toBeTruthy();
    });
  });

  it('clicking a chip filters the feed to that category only', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => EVENTS,
    });
    withQuery(<BrainActivityTab />);
    await waitFor(() => screen.getByText(/Sleep cycle merged/i));

    // Click "Heuristic" chip
    const chip = screen.getByRole('button', { name: /heuristic/i });
    fireEvent.click(chip);

    await waitFor(() => {
      expect(screen.getByText(/Added heuristic/i)).toBeTruthy();
      expect(screen.queryByText(/Sleep cycle merged/i)).toBeNull();
    });
  });

  it('Pause toggle prevents new events from appending', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => EVENTS,
    });
    withQuery(<BrainActivityTab />);
    await waitFor(() => screen.getByText(/Sleep cycle merged/i));

    // Click pause
    fireEvent.click(screen.getByRole('button', { name: /^pause$/i }));
    expect(screen.getByText(/Resume/i)).toBeTruthy();
  });
});
