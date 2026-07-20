import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useStickToBottomScroll } from '../useStickToBottomScroll';

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
  });

  it('exposes immediate and smooth scroll helpers', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { value: 800, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    el.scrollTop = 0;
    el.classList.add('overflow-y-auto');
    el.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      el.scrollTop = Number(top) || 0;
    }) as unknown as typeof el.scrollTo;

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
      expect.objectContaining({ behavior: 'smooth' }),
    );
  });
});
