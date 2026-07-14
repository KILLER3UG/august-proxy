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
});
