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
      (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16) as unknown as number,
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
      });
    });

    result.current.scrollToBottomImmediate();
    expect(el.scrollTop).toBe(800);

    result.current.scrollToBottomSmooth();
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
});
