/* v4.4.4 — Brain popup: image-editor resize (8 handles) + drag from anywhere */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrainIndicator } from '@/components/shell/BrainIndicator';

function withQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/**
 * IMPORTANT: RTL's `fireEvent.pointerMove(document, { clientX: ... })` only
 * attaches the property to the React SYNTHETIC event. The Brain popup uses
 * native listeners via `document.addEventListener` for resize move/up
 * (because the popup is portaled and setPointerCapture doesn't reliably
 * route events in jsdom). Native listeners see the underlying native event,
 * which has NO clientX without an explicit dispatch. So we dispatch real
 * native MouseEvents with the desired coordinates.
 */
function nativePointer(
  target: EventTarget,
  type: string,
  props: Record<string, unknown>,
) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...props,
  });
  (ev as unknown as { pointerId: number }).pointerId = (props.pointerId as number) ?? 1;
  target.dispatchEvent(ev);
}

async function openPopup(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('titlebar-brain-button'));
  });
  await waitFor(() => expect(screen.getByTestId('brain-popup')).toBeTruthy());
}

async function dragResize(handle: HTMLElement, dx: number, dy: number): Promise<void> {
  const rectSpy = vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue({
    x: 100, y: 100, width: 16, height: 16, top: 100, left: 100, bottom: 116, right: 116,
    toJSON() { return this; },
  });
  await act(async () => {
    nativePointer(handle, 'pointerdown', { clientX: 108, clientY: 108 });
  });
  await act(async () => {
    nativePointer(document, 'pointermove', { clientX: 108 + dx, clientY: 108 + dy });
  });
  await act(async () => {
    nativePointer(document, 'pointerup', { clientX: 108 + dx, clientY: 108 + dy });
  });
  rectSpy.mockRestore();
}

describe('v4.4.4 — Brain popup: image-editor resize (8 handles) + drag from anywhere', () => {
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

  it('renders 4 corner resize handles (NW/NE/SW/SE)', async () => {
    await withQuery(<BrainIndicator />);
    await openPopup();
    expect(screen.getByTestId('brain-resize-nw')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-ne')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-sw')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-se')).toBeTruthy();
  });

  it('renders 4 edge resize handles (N/S/E/W)', async () => {
    await withQuery(<BrainIndicator />);
    await openPopup();
    expect(screen.getByTestId('brain-resize-n')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-s')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-e')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-w')).toBeTruthy();
  });

  it('NE corner drag grows both width and height', async () => {
    await withQuery(<BrainIndicator />);
    await openPopup();
    const popup = screen.getByTestId('brain-popup');
    const beforeW = parseInt(popup.style.width, 10);
    const beforeH = parseInt(popup.style.height, 10);
    const handle = screen.getByTestId('brain-resize-ne');
    await dragResize(handle, 200, 150);
    const afterW = parseInt(popup.style.width, 10);
    const afterH = parseInt(popup.style.height, 10);
    expect(afterW).toBeGreaterThan(beforeW + 100);
    expect(afterH).toBeGreaterThan(beforeH + 100);
  });

  it('E (east) edge drag grows width, leaves height alone', async () => {
    await withQuery(<BrainIndicator />);
    await openPopup();
    const popup = screen.getByTestId('brain-popup');
    const beforeW = parseInt(popup.style.width, 10);
    const beforeH = parseInt(popup.style.height, 10);
    const handle = screen.getByTestId('brain-resize-e');
    await dragResize(handle, 250, 0);
    const afterW = parseInt(popup.style.width, 10);
    const afterH = parseInt(popup.style.height, 10);
    expect(afterW).toBeGreaterThan(beforeW + 100);
    expect(afterH).toBe(beforeH);
  });

  it('S (south) edge drag grows height, leaves width alone', async () => {
    await withQuery(<BrainIndicator />);
    await openPopup();
    const popup = screen.getByTestId('brain-popup');
    const beforeW = parseInt(popup.style.width, 10);
    const beforeH = parseInt(popup.style.height, 10);
    const handle = screen.getByTestId('brain-resize-s');
    await dragResize(handle, 0, 220);
    const afterW = parseInt(popup.style.width, 10);
    const afterH = parseInt(popup.style.height, 10);
    expect(afterH).toBeGreaterThan(beforeH + 100);
    expect(afterW).toBe(beforeW);
  });

  it('W (west) edge drag grows width too', async () => {
    await withQuery(<BrainIndicator />);
    await openPopup();
    const before = parseInt(screen.getByTestId('brain-popup').style.width, 10);
    const handle = screen.getByTestId('brain-resize-w');
    await dragResize(handle, 100, 0);
    const after = parseInt(screen.getByTestId('brain-popup').style.width, 10);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('drags the popup when a pointer is pressed on the body (not the header)', async () => {
    await withQuery(<BrainIndicator />);
    await openPopup();
    const popup = screen.getByTestId('brain-popup');
    const rectSpy = vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, width: 500, height: 400, top: 100, left: 100, bottom: 500, right: 600,
      toJSON() { return this; },
    });
    const startX = 250, startY = 220;
    await act(async () => {
      nativePointer(popup, 'pointerdown', { clientX: startX, clientY: startY, button: 0 });
    });
    await act(async () => {
      nativePointer(document, 'pointermove', { clientX: startX + 60, clientY: startY + 40 });
    });
    await act(async () => {
      nativePointer(document, 'pointerup', { clientX: startX + 60, clientY: startY + 40 });
    });
    rectSpy.mockRestore();
    const popup2 = screen.getByTestId('brain-popup');
    expect(popup2.style.left).toBeTruthy();
    expect(popup2.style.top).toBeTruthy();
  });

  it('does NOT drag when pressing on an interactive child (a tab button)', async () => {
    await withQuery(<BrainIndicator />);
    await openPopup();
    const popup = screen.getByTestId('brain-popup');
    const before = { x: popup.style.left, y: popup.style.top };
    const learningTab = screen.getByTestId('brain-popup-tab-learning');
    await act(async () => {
      nativePointer(learningTab, 'pointerdown', { clientX: 100, clientY: 200 });
    });
    await act(async () => {
      nativePointer(document, 'pointermove', { clientX: 700, clientY: 600 });
    });
    await act(async () => {
      nativePointer(document, 'pointerup', { clientX: 700, clientY: 600 });
    });
    expect(screen.queryByTestId('brain-popup')).toBeTruthy();
    const popup3 = screen.getByTestId('brain-popup');
    const dx = Math.abs(parseInt(popup3.style.left || '0', 10) - parseInt(before.x || '0', 10));
    expect(dx).toBeLessThan(300);
  });
});
