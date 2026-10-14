import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import { useStickToBottomScroll } from '../useStickToBottomScroll';

function makeScrollEl() {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
  el.scrollTop = 400;
  el.classList.add('overflow-y-auto', 'chat-scroll');
  el.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    el.scrollTop = Number(top) || 0;
  }) as unknown as typeof el.scrollTo;
  document.body.appendChild(el);
  return el;
}

describe('useStickToBottomScroll', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16),
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('exposes immediate and smooth scroll helpers', () => {
    const el = makeScrollEl();

    const { result } = renderHook(() => {
      const scrollRef = useRef<HTMLDivElement | null>(el);
      const pinnedToBottomRef = useRef(true);
      return useStickToBottomScroll({
        scrollRef,
        pinnedToBottomRef,
        streaming: false,
        sessionId: 's1',
        loadedSessionId: 's1',
        messagesVersion: 1,
        hasContent: true,
      });
    });

    result.current.scrollToBottomImmediate();
    expect(el.scrollTop).toBe(800);

    result.current.scrollToBottomSmooth();
    // el.scrollTo is a vi.fn() assigned in makeScrollEl — no this-binding risk.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(el.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 800, behavior: 'smooth' }),
    );
  });

  it('releases pin and adds free class on upward wheel', () => {
    const el = makeScrollEl();
    const pinnedToBottomRef = { current: true };
    const onPinnedChange = vi.fn();

    renderHook(() => {
      const scrollRef = useRef<HTMLDivElement | null>(el);
      return useStickToBottomScroll({
        scrollRef,
        pinnedToBottomRef,
        streaming: true,
        sessionId: 's1',
        loadedSessionId: 's1',
        messagesVersion: 1,
        hasContent: true,
        onPinnedChange,
      });
    });

    act(() => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    });

    expect(pinnedToBottomRef.current).toBe(false);
    expect(el.classList.contains('chat-scroll--free')).toBe(true);
    expect(onPinnedChange).toHaveBeenCalledWith(false);
  });

  it('re-pins and clears free class via setPinned(true)', () => {
    const el = makeScrollEl();
    const pinnedToBottomRef = { current: false };

    const { result } = renderHook(() => {
      const scrollRef = useRef<HTMLDivElement | null>(el);
      return useStickToBottomScroll({
        scrollRef,
        pinnedToBottomRef,
        streaming: true,
        sessionId: 's1',
        loadedSessionId: 's1',
        messagesVersion: 1,
        hasContent: true,
      });
    });

    act(() => {
      result.current.setPinned(false);
    });
    expect(el.classList.contains('chat-scroll--free')).toBe(true);

    act(() => {
      result.current.setPinned(true);
    });
    expect(pinnedToBottomRef.current).toBe(true);
    expect(el.classList.contains('chat-scroll--free')).toBe(false);
  });

  it('immediate scroll re-snaps while the page height settles (virtualized re-measure)', async () => {
    const el = makeScrollEl();

    const { result } = renderHook(() => {
      const scrollRef = useRef<HTMLDivElement | null>(el);
      const pinnedToBottomRef = useRef(true);
      return useStickToBottomScroll({
        scrollRef,
        pinnedToBottomRef,
        streaming: false,
        sessionId: 's1',
        loadedSessionId: 's1',
        messagesVersion: 1,
        hasContent: true,
      });
    });

    result.current.scrollToBottomImmediate();
    expect(el.scrollTop).toBe(800);

    // Rows entering the viewport measure taller → the page grows after the snap.
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    await new Promise((r) => setTimeout(r, 120));
    expect(el.scrollTop).toBe(1000);
  });

  it('settle survives quiet gaps between measurement waves (long transcript switch)', async () => {
    const el = makeScrollEl();

    const { result } = renderHook(() => {
      const scrollRef = useRef<HTMLDivElement | null>(el);
      const pinnedToBottomRef = useRef(true);
      return useStickToBottomScroll({
        scrollRef,
        pinnedToBottomRef,
        streaming: false,
        sessionId: 's1',
        loadedSessionId: 's1',
        messagesVersion: 1,
        hasContent: true,
      });
    });

    result.current.scrollToBottomImmediate();
    // First measurement wave: bottom rows render taller than estimated.
    Object.defineProperty(el, 'scrollHeight', { value: 1200, configurable: true });

    // Quiet gap longer than the old 2-frame tolerance but well inside the
    // new one — the old loop exited here and missed the second wave.
    await new Promise((r) => setTimeout(r, 80));
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });

    await new Promise((r) => setTimeout(r, 220));
    expect(el.scrollTop).toBe(2000);
  });

  it('settle stops fighting a user who scrolls away mid-settle', async () => {
    const el = makeScrollEl();
    const pinnedToBottomRef = { current: true };

    const { result } = renderHook(() => {
      const scrollRef = useRef<HTMLDivElement | null>(el);
      return useStickToBottomScroll({
        scrollRef,
        pinnedToBottomRef,
        streaming: false,
        sessionId: 's1',
        loadedSessionId: 's1',
        messagesVersion: 1,
        hasContent: true,
      });
    });

    result.current.scrollToBottomImmediate();
    // User wheels up before the next frame — pin releases.
    pinnedToBottomRef.current = false;
    el.scrollTop = 100;
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    await new Promise((r) => setTimeout(r, 120));
    // The settle pass must not have yanked the viewport back down.
    expect(el.scrollTop).toBe(100);
  });

  it('releases the pin when the view moves up with no wheel, touch or key event', async () => {
    // Dragging the scrollbar, a trackpad gesture that arrives as a bare scroll,
    // a focus change inside the transcript and `scrollIntoView` from a tool card
    // all move scrollTop without emitting anything the old listeners watched —
    // so the pin held and streaming kept pulling the reader back down.
    const el = makeScrollEl();
    const pinnedToBottomRef = { current: true };
    const onPinnedChange = vi.fn();

    renderHook(() =>
      useStickToBottomScroll({
        scrollRef: { current: el } as React.RefObject<HTMLDivElement>,
        pinnedToBottomRef,
        streaming: true,
        sessionId: 's1',
        loadedSessionId: 's1',
        messagesVersion: 1,
        hasContent: true,
        onPinnedChange,
      }),
    );

    act(() => {
      el.scrollTop = 200;
      el.dispatchEvent(new Event('scroll'));
    });

    expect(onPinnedChange).toHaveBeenCalledWith(false);
    expect(pinnedToBottomRef.current).toBe(false);
  });

  it('holds the pin when the view moves down', () => {
    const el = makeScrollEl();
    const onPinnedChange = vi.fn();

    renderHook(() =>
      useStickToBottomScroll({
        scrollRef: { current: el } as React.RefObject<HTMLDivElement>,
        pinnedToBottomRef: { current: true },
        streaming: true,
        sessionId: 's1',
        loadedSessionId: 's1',
        messagesVersion: 1,
        hasContent: true,
        onPinnedChange,
      }),
    );

    act(() => {
      el.scrollTop = 400;
      el.dispatchEvent(new Event('scroll'));
      el.scrollTop = 402;
      el.dispatchEvent(new Event('scroll'));
    });

    expect(onPinnedChange).not.toHaveBeenCalledWith(false);
  });
});
