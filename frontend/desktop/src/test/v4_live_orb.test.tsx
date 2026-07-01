import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LiveOrb } from '@/sections/live/LiveOrb';

describe('v4 — LiveOrb', () => {
  it('renders an orb for each state', () => {
    for (const state of ['idle', 'listening', 'thinking', 'speaking'] as const) {
      const { container } = render(<LiveOrb state={state} />);
      const orb = container.querySelector('[data-testid="live-orb"]');
      expect(orb).toBeTruthy();
      expect(orb?.getAttribute('data-state')).toBe(state);
    }
  });

  it('renders the state label inside the orb', () => {
    const { container } = render(<LiveOrb state="listening" />);
    expect(container.textContent).toContain('listening');
  });
});
