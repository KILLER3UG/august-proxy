import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
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

  it('marks overflow when text is wider than the container', () => {
    const { container } = render(
      <div style={{ width: 40 }}>
        <MarqueeTitle
          text="Very long session title that might overflow the session bar"
          data-testid="session-bar-title"
        />
      </div>,
    );
    const outer = screen.getByTestId('session-bar-title');
    const inner = outer.querySelector('span');
    Object.defineProperty(outer, 'clientWidth', { configurable: true, value: 40 });
    Object.defineProperty(inner, 'scrollWidth', { configurable: true, value: 240 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(outer.getAttribute('data-overflow')).toBe('true');
    expect(inner?.className).toContain('marquee-title-scroll');
    expect(container.querySelector('.group\\/marquee')).toBeTruthy();
  });
});
