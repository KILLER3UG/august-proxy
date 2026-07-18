/* v4.4.4 — Brain popup: image-editor resize (8 handles) + drag from anywhere */
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
  act(() => {
    fireEvent.click(screen.getByTestId('titlebar-brain-button'));
  });
  await waitFor(() => expect(screen.getByTestId('brain-popup')).toBeTruthy());
}

function dragResize(handle: HTMLElement, dx: number, dy: number): void {
  const rectSpy = vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue({
    x: 100, y: 100, width: 16, height: 16, top: 100, left: 100, bottom: 116, right: 116,
    toJSON() { return this; },
  });
  act(() => {
    nativePointer(handle, 'pointerdown', { clientX: 108, clientY: 108 });
  });
  act(() => {
    // Listeners are on window (survives portal re-renders / leave-viewport)
    nativePointer(window, 'pointermove', { clientX: 108 + dx, clientY: 108 + dy });
  });
  act(() => {
    nativePointer(window, 'pointerup', { clientX: 108 + dx, clientY: 108 + dy });
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
    withQuery(<BrainIndicator />);
    await openPopup();
    expect(screen.getByTestId('brain-resize-nw')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-ne')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-sw')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-se')).toBeTruthy();
  });

  it('renders 4 edge resize handles (N/S/E/W)', async () => {
    withQuery(<BrainIndicator />);
    await openPopup();
    expect(screen.getByTestId('brain-resize-n')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-s')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-e')).toBeTruthy();
    expect(screen.getByTestId('brain-resize-w')).toBeTruthy();
  });

  it('NE corner: drag right grows width; drag up grows height (image-editor)', async () => {
    withQuery(<BrainIndicator />);
    await openPopup();
    const popup = screen.getByTestId('brain-popup');
    const beforeW = parseInt(popup.style.width, 10);
    const beforeH = parseInt(popup.style.height, 10);
    const handle = screen.getByTestId('brain-resize-ne');
    // +dx grows east; -dy moves north edge up → taller
    dragResize(handle, 200, -150);
    const afterW = parseInt(popup.style.width, 10);
    const afterH = parseInt(popup.style.height, 10);
    expect(afterW).toBeGreaterThan(beforeW + 100);
    expect(afterH).toBeGreaterThan(beforeH + 100);
  });

  it('E (east) edge drag grows width, leaves height alone', async () => {
    withQuery(<BrainIndicator />);
    await openPopup();
    const popup = screen.getByTestId('brain-popup');
    const beforeW = parseInt(popup.style.width, 10);
    const beforeH = parseInt(popup.style.height, 10);
    const handle = screen.getByTestId('brain-resize-e');
    dragResize(handle, 250, 0);
    const afterW = parseInt(popup.style.width, 10);
    const afterH = parseInt(popup.style.height, 10);
    expect(afterW).toBeGreaterThan(beforeW + 100);
    expect(afterH).toBe(beforeH);
  });

  it('S (south) edge drag grows height, leaves width alone', async () => {
    withQuery(<BrainIndicator />);
    await openPopup();
    const popup = screen.getByTestId('brain-popup');
    const beforeW = parseInt(popup.style.width, 10);
    const beforeH = parseInt(popup.style.height, 10);
    const handle = screen.getByTestId('brain-resize-s');
    dragResize(handle, 0, 220);
    const afterW = parseInt(popup.style.width, 10);
    const afterH = parseInt(popup.style.height, 10);
    expect(afterH).toBeGreaterThan(beforeH + 100);
    expect(afterW).toBe(beforeW);
  });

  it('W (west) edge drag left grows width', async () => {
    withQuery(<BrainIndicator />);
    await openPopup();
    const before = parseInt(screen.getByTestId('brain-popup').style.width, 10);
    const handle = screen.getByTestId('brain-resize-w');
    // Negative dx = drag left → wider (east edge anchored)
    dragResize(handle, -100, 0);
    const after = parseInt(screen.getByTestId('brain-popup').style.width, 10);
    expect(after).toBeGreaterThan(before);
  });

  it('drags the popup 1:1 with cursor delta', async () => {
    // Seed a mid-viewport position so clamp does not block the +dx/+dy move
    // (default geom is top-right and cannot move further right).
    localStorage.setItem(
      'august-brain-popup-state',
      JSON.stringify({ width: 520, height: 520, x: 200, y: 100 }),
    );
    withQuery(<BrainIndicator />);
    await openPopup();
    const popup = screen.getByTestId('brain-popup');
    const handle = screen.getByTestId('brain-drag-handle');
    const beforeLeft = parseInt(popup.style.left, 10);
    const beforeTop = parseInt(popup.style.top, 10);
    expect(beforeLeft).toBe(200);
    expect(beforeTop).toBe(100);
    const startX = 250;
    const startY = 120;
    act(() => {
      // Start on the header (guaranteed non-interactive target for drag)
      nativePointer(handle, 'pointerdown', { clientX: startX, clientY: startY, button: 0 });
    });
    act(() => {
      nativePointer(window, 'pointermove', { clientX: startX + 60, clientY: startY + 40 });
    });
    act(() => {
      nativePointer(window, 'pointerup', { clientX: startX + 60, clientY: startY + 40 });
    });
    const popup2 = screen.getByTestId('brain-popup');
    expect(parseInt(popup2.style.left, 10)).toBe(beforeLeft + 60);
    expect(parseInt(popup2.style.top, 10)).toBe(beforeTop + 40);
  });

  it('does NOT drag when pressing on an interactive child (a tab button)', async () => {
    withQuery(<BrainIndicator />);
    await openPopup();
    const popup = screen.getByTestId('brain-popup');
    const before = { x: popup.style.left, y: popup.style.top };
    const learningTab = screen.getByTestId('brain-popup-tab-learning');
    act(() => {
      nativePointer(learningTab, 'pointerdown', { clientX: 100, clientY: 200 });
    });
    act(() => {
      nativePointer(window, 'pointermove', { clientX: 700, clientY: 600 });
    });
    act(() => {
      nativePointer(window, 'pointerup', { clientX: 700, clientY: 600 });
    });
    expect(screen.queryByTestId('brain-popup')).toBeTruthy();
    const popup3 = screen.getByTestId('brain-popup');
    const dx = Math.abs(parseInt(popup3.style.left || '0', 10) - parseInt(before.x || '0', 10));
    expect(dx).toBeLessThan(300);
  });
});
