/* v4.4.3 — Regression: Brain popup must escape transformed ancestors.
   The chat shell uses framer-motion (motion.div sets transform), which
   creates a containing block for position:fixed. Without a portal, the
   popup gets trapped inside the titlebar/stacking context and goes off-
   screen on the chat route while appearing correctly on routes that
   don't wrap content in motion.div (Settings, full-window overlays). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BrainIndicator } from '@/components/shell/BrainIndicator';

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('v4.4.3 — Brain popup escapes transformed ancestors via portal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    class MockEventSource {
      addEventListener() {}
      close() {}
      onmessage: ((ev: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
    }
    (globalThis as any).EventSource = MockEventSource;
  });

  it('renders the popup inside document.body (not the transformed ancestor)', async () => {
    withQuery(
      <div style={{ transform: 'translate3d(10px, 20px, 30px)' }} data-testid="transformed-parent">
        <BrainIndicator />
      </div>,
    );
    act(() => {
      fireEvent.click(screen.getByTestId('titlebar-brain-button'));
    });
    await waitFor(() => expect(screen.getByTestId('brain-popup')).toBeTruthy());

    // The popup's closest ancestor should be document.body — NOT the transformed div.
    const popup = screen.getByTestId('brain-popup');
    const transformedParent = screen.getByTestId('transformed-parent');
    expect(transformedParent.contains(popup)).toBe(false);
  });
});
