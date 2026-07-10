/* v4.4.1 — BrainIndicator + BrainPopup: floating popup near icon, pulse dot on new events */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrainIndicator } from '@/components/shell/BrainIndicator';

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
    meta: { merged: 2 },
    at: '2026-06-30T10:24:15Z',
  },
];

describe('v4.4.1 — BrainIndicator (floating popup)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    class MockEventSource {
      addEventListener() {}
      close() {}
      onmessage: ((ev: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
    }
    (globalThis as any).EventSource = MockEventSource;
  });

  it('renders the Brain icon button', () => {
    withQuery(<BrainIndicator />);
    expect(screen.getByTestId('titlebar-brain-button')).toBeTruthy();
  });

  it('does not render the popup by default', () => {
    withQuery(<BrainIndicator />);
    expect(screen.queryByTestId('brain-popup')).toBeNull();
  });

  it('clicking the icon opens the popup (floating, no backdrop)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => EVENTS,
    });
    withQuery(<BrainIndicator />);
    act(() => {
      fireEvent.click(screen.getByTestId('titlebar-brain-button'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('brain-popup')).toBeTruthy();
      // Activity tab default — events visible
      expect(screen.getByText(/Sleep cycle merged/i)).toBeTruthy();
    });
  });

  it('clicking the icon again closes the popup', async () => {
    withQuery(<BrainIndicator />);
    const btn = screen.getByTestId('titlebar-brain-button');
    act(() => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(screen.queryByTestId('brain-popup')).toBeTruthy());
    act(() => {
      fireEvent.click(btn);
    });
    expect(screen.queryByTestId('brain-popup')).toBeNull();
  });

  it('shows the pulse dot when there are unseen events', () => {
    withQuery(<BrainIndicator initialUnseen={3} />);
    const dot = screen.getByTestId('brain-pulse-dot');
    expect(dot).toBeTruthy();
  });

  it('hides the pulse dot when unseen events is zero', () => {
    withQuery(<BrainIndicator initialUnseen={0} />);
    expect(screen.queryByTestId('brain-pulse-dot')).toBeNull();
  });
});
