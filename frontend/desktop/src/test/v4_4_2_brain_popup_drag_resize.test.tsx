/* v4.4.2 — Brain popup: drag-anywhere + resize-handle + only-×-closes + persist */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrainIndicator } from '@/components/shell/BrainIndicator';

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const _EVENTS = [
  {
    id: 'e1',
    category: 'consolidation' as const,
    layer: 'consolidation_daemon',
    summary: 'Sleep cycle merged 2 duplicate Yarn rules',
    meta: { merged: 2 },
    at: '2026-06-30T10:24:15Z',
  },
];

describe('v4.4.2 — Brain popup: drag, resize, dismiss behavior', () => {
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

  it('renders a drag handle in the popup header', () => {
    withQuery(<BrainIndicator />);
    act(() => {
      fireEvent.click(screen.getByTestId('titlebar-brain-button'));
    });
    expect(screen.getByTestId('brain-drag-handle')).toBeTruthy();
  });

  it('renders a resize handle in the bottom-right corner', () => {
    withQuery(<BrainIndicator />);
    act(() => {
      fireEvent.click(screen.getByTestId('titlebar-brain-button'));
    });
    expect(screen.getByTestId('brain-resize-handle')).toBeTruthy();
  });

  it('does NOT close the popup when Escape is pressed', async () => {
    withQuery(<BrainIndicator />);
    act(() => {
      fireEvent.click(screen.getByTestId('titlebar-brain-button'));
    });
    await waitFor(() => expect(screen.getByTestId('brain-popup')).toBeTruthy());
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('brain-popup')).toBeTruthy();
  });

  it('does NOT close when clicking outside the popup', async () => {
    withQuery(
      <div>
        <div data-testid="outside">outside</div>
        <BrainIndicator />
      </div>,
    );
    act(() => {
      fireEvent.click(screen.getByTestId('titlebar-brain-button'));
    });
    await waitFor(() => expect(screen.getByTestId('brain-popup')).toBeTruthy());
    // Click "outside" — a mousedown on something that's not the popup or the toggle
    act(() => {
      fireEvent.mouseDown(screen.getByTestId('outside'));
    });
    expect(screen.queryByTestId('brain-popup')).toBeTruthy();
  });

  it('only the × button closes the popup', async () => {
    withQuery(<BrainIndicator />);
    act(() => {
      fireEvent.click(screen.getByTestId('titlebar-brain-button'));
    });
    await waitFor(() => expect(screen.getByTestId('brain-popup')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByTestId('brain-popup')).toBeNull();
  });

  it('drags the popup when the header is grabbed and moved', () => {
    withQuery(<BrainIndicator />);
    act(() => {
      fireEvent.click(screen.getByTestId('titlebar-brain-button'));
    });
    const handle = screen.getByTestId('brain-drag-handle');
    // Mock header at top-left of the popup (popup starts at top-right of viewport
    // by default; we drag LEFT+DOWN so the drag isn't clamped by viewport edges).
    const rectSpy = vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue({
      x: 200, y: 80, width: 400, height: 32, top: 80, left: 200, bottom: 112, right: 600, toJSON() {},
    });
    const startLeft = parseInt(screen.getByTestId('brain-popup').style.left, 10) || 0;
    const startTop = parseInt(screen.getByTestId('brain-popup').style.top, 10) || 0;
    act(() => {
      const ev = new MouseEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 100 });
      (ev as unknown as { pointerId: number }).pointerId = 1;
      handle.dispatchEvent(ev);
    });
    act(() => {
      const ev = new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 200 });
      (ev as unknown as { pointerId: number }).pointerId = 1;
      document.dispatchEvent(ev);
    });
    act(() => {
      const ev = new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 200 });
      (ev as unknown as { pointerId: number }).pointerId = 1;
      document.dispatchEvent(ev);
    });
    rectSpy.mockRestore();
    const popup = screen.getByTestId('brain-popup');
    const afterLeft = parseInt(popup.style.left, 10);
    const afterTop = parseInt(popup.style.top, 10);
    // Drag was 200px left and 100px down — both should be reflected.
    expect(Math.abs(afterLeft - startLeft)).toBeGreaterThan(50);
    expect(Math.abs(afterTop - startTop)).toBeGreaterThan(50);
  });

  it('resizes via the bottom-right handle pointer drag', () => {
    withQuery(<BrainIndicator />);
    act(() => {
      fireEvent.click(screen.getByTestId('titlebar-brain-button'));
    });
    const handle = screen.getByTestId('brain-resize-handle');
    const rectSpy = vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue({
      x: 600, y: 600, width: 16, height: 16, top: 600, left: 600, bottom: 616, right: 616, toJSON() {},
    });
    fireEvent.pointerDown(handle, { clientX: 608, clientY: 608, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 800, clientY: 800, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    rectSpy.mockRestore();
    const popup = screen.getByTestId('brain-popup');
    // Width/height inline style must have grown
    const w = parseInt(popup.style.width, 10);
    expect(w).toBeGreaterThan(400);
  });

  it('persists position + size to localStorage', () => {
    withQuery(<BrainIndicator />);
    act(() => {
      fireEvent.click(screen.getByTestId('titlebar-brain-button'));
    });
    // Closing should persist current size/pos
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    const stored = localStorage.getItem('august-brain-popup-state');
    expect(stored).toBeTruthy();
  });
});
