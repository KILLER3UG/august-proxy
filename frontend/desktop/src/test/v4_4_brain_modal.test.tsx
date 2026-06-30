/* v4.4 — BrainModal: small overlay that opens from the titlebar, defaults to Activity */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrainModal } from '@/components/shell/BrainModal';

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

describe('v4.4 — BrainModal', () => {
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

  it('renders nothing when closed', () => {
    withQuery(<BrainModal open={false} onClose={() => {}} />);
    expect(screen.queryByTestId('brain-modal')).toBeNull();
  });

  it('renders the modal with Activity tab as the default when open', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => EVENTS,
    });
    withQuery(<BrainModal open={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId('brain-modal')).toBeTruthy();
      // Activity tab is the default — events should be visible
      expect(screen.getByText(/Sleep cycle merged/i)).toBeTruthy();
    });
  });

  it('clicking the close button calls onClose', () => {
    const onClose = vi.fn();
    withQuery(<BrainModal open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking Learning tab swaps the body without closing the modal', async () => {
    withQuery(<BrainModal open={true} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /learning/i }));
    });
    expect(screen.getByTestId('brain-modal')).toBeTruthy();
  });
});
