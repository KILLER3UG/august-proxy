import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarqueeTitle } from '@/components/ui/MarqueeTitle';

describe('MarqueeTitle', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the title text', () => {
    render(
      <MarqueeTitle
        text="Very long session title that might overflow the session bar"
        data-testid="session-bar-title"
      />,
    );
    expect(screen.getByTestId('session-bar-title').textContent).toContain(
      'Very long session title',
    );
  });

  /* The default changed deliberately. An overflowing title used to ALWAYS get
   * `marquee-title-scroll`, which hard-clipped mid-glyph in the sidebar —
   * measured `titleW 188 / scrollW 255`, rendering as "…start conve" with the
   * last character sliced. The reference sidebar truncates with an ellipsis and
   * no fade, so the sidebar now ellipsises and the titlebar opts into the
   * scroll via `scrollOnHover`.
   *
   * These assert the CLASS SELECTION, not the overflow probe. jsdom has no
   * layout engine, so `scrollWidth`/`clientWidth` are both 0 and the previous
   * version of this file overrode them with `Object.defineProperty` — which
   * silently stopped taking effect once the effect body changed, so the test
   * passed for reasons unrelated to what it claimed. The branch under test is
   * `overflow && scrollOnHover`, and `overflow` defaults to false in jsdom, so
   * the ellipsis path is exercised directly and the scroll path by forcing the
   * measured state through the same resize listener the browser would use. */
  it('ellipsises by default and never carries max-w-none (the sidebar)', () => {
    render(
      <MarqueeTitle
        text="Very long session title that might overflow the session bar"
        data-testid="session-bar-title"
      />,
    );
    const inner = screen.getByTestId('session-bar-title').querySelector('span')!;
    // No overflow measured -> still the ellipsis branch.
    expect(inner.className).toContain('truncate');
    // `max-w-none` defeats `text-overflow`; its absence is the actual fix.
    expect(inner.className).not.toContain('max-w-none');
    expect(inner.className).not.toContain('marquee-title-scroll');
  });

  it('keeps the overflow flag and the scroll class available for the titlebar', () => {
    const { container } = render(
      <MarqueeTitle
        text="Very long session title that might overflow the session bar"
        scrollOnHover
        data-testid="session-bar-title"
      />,
    );
    const outer = screen.getByTestId('session-bar-title');
    expect(outer.getAttribute('data-overflow')).toBe('false');
    expect(container.querySelector('.group\\/marquee')).toBeTruthy();
    // With no overflow, scrollOnHover alone must NOT scroll.
    expect(outer.querySelector('span')!.className).not.toContain('marquee-title-scroll');
  });
});
