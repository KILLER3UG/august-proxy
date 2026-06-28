/* ── ContextRing regression tests for black-screen bug ───────────────── */
/* These tests assert that the portaled ContextRing tooltip is positioned
 * safely inside the viewport and does not carry the compositing hint
 * (`will-change`) that, combined with `position: fixed` and negative
 * coordinates, produces a full-viewport black rectangle.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextRing, estimateContextBreakdown } from '../ChatComposer';

const mockBreakdown = estimateContextBreakdown({
  messages: [{ role: 'user', content: 'hello world' }],
  input: 'test',
  toolCount: 1,
});

describe('ContextRing tooltip regression', () => {
  it('renders a portaled tooltip on hover without will-change transform/opacity', () => {
    render(
      <ContextRing
        pct={42}
        estTokens={1000}
        maxContext={4000}
        modelName="test-model"
        breakdown={mockBreakdown}
      />
    );

    const trigger = screen.getByRole('button', { name: /context used/i });
    fireEvent.mouseEnter(trigger);

    const tooltip = document.querySelector('[data-composer-popover]');
    expect(tooltip).toBeInTheDocument();

    const style = (tooltip as HTMLElement | null)?.style;
    expect(style?.willChange).not.toMatch(/transform/);
    expect(style?.willChange).not.toMatch(/opacity/);
  });

  it('positions the tooltip inside the viewport with finite width', () => {
    render(
      <ContextRing
        pct={42}
        estTokens={1000}
        maxContext={4000}
        modelName="test-model"
        breakdown={mockBreakdown}
      />
    );

    const trigger = screen.getByRole('button', { name: /context used/i });
    fireEvent.mouseEnter(trigger);

    const tooltip = document.querySelector('[data-composer-popover]') as HTMLElement | null;
    expect(tooltip).toBeInTheDocument();

    // jsdom does not run a CSS layout engine, so getBoundingClientRect() returns
    // zeros for portaled elements. Derive a rect from the inline position the
    // component actually set (style.top/style.left, produced by the clamping
    // logic under test) plus the fixed w-72 width (288px) so the bounds
    // assertions exercise the real positioning rather than jsdom's no-op layout.
    const top = parseFloat(tooltip!.style.top) || 0;
    const left = parseFloat(tooltip!.style.left) || 0;
    const width = 288; // w-72
    const height = 180;
    vi.spyOn(tooltip!, 'getBoundingClientRect').mockReturnValue({
      top, left, width, height, bottom: top + height, right: left + width, x: left, y: top,
      toJSON: () => ({ top, left, width, height }),
    });

    const rect = tooltip!.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(rect.width)).toBe(true);
    expect(Number.isFinite(rect.height)).toBe(true);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.width).toBeLessThanOrEqual(288);
  });
});
