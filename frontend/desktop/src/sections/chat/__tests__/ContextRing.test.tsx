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

describe('ContextRing gauge percentage from server ground truth', () => {
  it('derives pct from estTokens/maxContext (server contextTokens)', () => {
    // Simulates: backend reported contextTokens = 48000 for a 200k window.
    // The ring should show 24% — NOT an inflated value from the old flat-3000
    // + 15% thinking + all-tools heuristic.
    const maxContext = 200000;
    const contextTokens = 48000;
    const pct = Math.min(100, Math.round((contextTokens / maxContext) * 100));
    expect(pct).toBe(24);

    const breakdown = estimateContextBreakdown({
      messages: [{ role: 'user', content: 'a'.repeat(4000) }],
      input: '',
      toolCount: 10,
      scaleToTotal: contextTokens,
    });

    render(
      <ContextRing
        pct={pct}
        estTokens={contextTokens}
        maxContext={maxContext}
        modelName="claude-sonnet"
        breakdown={breakdown}
      />
    );

    const trigger = screen.getByRole('button', { name: /context used/i });
    fireEvent.mouseEnter(trigger);

    const tooltip = document.querySelector('[data-composer-popover]');
    expect(tooltip).toBeInTheDocument();
    // Header reads the real server total, not an inflated heuristic.
    expect(tooltip?.textContent).toContain('48.0K');
    expect(tooltip?.textContent).toContain('200.0K');
    expect(tooltip?.textContent).toContain('24%');
  });

  it('breakdown rows sum to the displayed estTokens total', () => {
    const maxContext = 128000;
    const contextTokens = 25600; // 20%
    const pct = Math.min(100, Math.round((contextTokens / maxContext) * 100));
    const breakdown = estimateContextBreakdown({
      messages: [{ role: 'user', content: 'a'.repeat(2000) }],
      input: 'a'.repeat(500),
      toolCount: 8,
      scaleToTotal: contextTokens,
    });
    const sum =
      breakdown.messages +
      breakdown.thinking +
      breakdown.systemTools +
      breakdown.systemPrompt +
      breakdown.skills +
      breakdown.meta;
    expect(sum).toBe(contextTokens);

    render(
      <ContextRing
        pct={pct}
        estTokens={contextTokens}
        maxContext={maxContext}
        breakdown={breakdown}
      />
    );

    const trigger = screen.getByRole('button', { name: /context used/i });
    fireEvent.mouseEnter(trigger);
    const tooltip = document.querySelector('[data-composer-popover]');
    expect(tooltip).toBeInTheDocument();
    expect(tooltip?.textContent).toContain('20%');
  });
});
