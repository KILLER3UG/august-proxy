import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '@/sections/chat/ChatMarkdown';

describe('v1.1 — math rendering', () => {
  it('renders x^2 as unicode superscript', () => {
    const { container } = render(<Markdown content="The formula x^2" />);
    expect(container.textContent).toContain('x²');
  });

  it('renders sum symbol as unicode', () => {
    const { container } = render(<Markdown content="The sum \\sum_{i=0}^{n}" />);
    expect(container.textContent).toMatch(/∑/);
  });

  it('renders >= as unicode', () => {
    const { container } = render(<Markdown content="x >= y" />);
    expect(container.textContent).toContain('≥');
  });

  it('renders pi as unicode', () => {
    const { container } = render(<Markdown content="\\pi is great" />);
    expect(container.textContent).toContain('π');
  });

  it('does not put invalid LaTeX in red error color', () => {
    // \\frac{ without closing brace is invalid LaTeX
    const { container } = render(<Markdown content="Bad: \\frac{1" />);
    // The source should be visible, but NOT inside an element with .katex-error class
    const errorEls = container.querySelectorAll('.katex-error');
    expect(errorEls.length).toBe(0);
  });

  it('does not convert $x^2$ inside a code block', () => {
    const code = '```\n$x^2$\n```';
    const { container } = render(<Markdown content={code} />);
    // Inside a <code> or <pre>, the literal $x^2$ should remain
    const codeEl = container.querySelector('pre code');
    expect(codeEl).not.toBeNull();
    expect(codeEl?.textContent).toContain('$x^2$');
  });

  it('preserves $5 as currency (not math)', () => {
    const { container } = render(<Markdown content="Cost: $5.00" />);
    // $5.00 should remain as literal currency
    expect(container.textContent).toContain('$5.00');
  });
});
