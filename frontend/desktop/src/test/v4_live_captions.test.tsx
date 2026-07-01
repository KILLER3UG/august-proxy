import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveCaptions } from '@/sections/live/LiveCaptions';

describe('v4 — LiveCaptions', () => {
  it('renders the partial transcript in muted style', () => {
    render(<LiveCaptions partial="Hello wo" transcript="" />);
    const partial = screen.getByTestId('captions-partial');
    expect(partial.textContent).toBe('Hello wo');
    expect(partial.className).toMatch(/opacity-/);
  });

  it('renders the committed transcript in solid text', () => {
    render(<LiveCaptions partial="" transcript="Hello world" />);
    expect(screen.getByTestId('captions-final').textContent).toBe('Hello world');
  });

  it('renders both when both are present (partial stacked above final)', () => {
    render(<LiveCaptions partial="there" transcript="Hello" />);
    expect(screen.getByTestId('captions-final').textContent).toBe('Hello');
    expect(screen.getByTestId('captions-partial').textContent).toBe('there');
  });

  it('omits the partial element when nothing is set', () => {
    render(<LiveCaptions partial="" transcript="" />);
    expect(screen.queryByTestId('captions-partial')).toBeNull();
    expect(screen.queryByTestId('captions-final')).toBeNull();
  });
});
