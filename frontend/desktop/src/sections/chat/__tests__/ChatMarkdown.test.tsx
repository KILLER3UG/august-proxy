import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Markdown } from '../ChatMarkdown';

describe('ChatMarkdown Component', () => {
  it('renders GFM markdown tables cleanly during live streaming (live=true)', () => {
    const tableMarkdown = `
| Header 1 | Header 2 |
| --- | --- |
| Row 1 Col 1 | Row 1 Col 2 |
| Row 2 Col 1 | Row 2 Col 2 |
`;

    const { container } = render(<Markdown content={tableMarkdown} live={true} />);

    // Must render true HTML table tags, not raw paragraph pipe lines
    const table = container.querySelector('table');
    expect(table).not.toBeNull();

    const headers = container.querySelectorAll('th');
    expect(headers.length).toBe(2);
    expect(headers[0].textContent).toBe('Header 1');
    expect(headers[1].textContent).toBe('Header 2');

    const cells = container.querySelectorAll('td');
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toBe('Row 1 Col 1');
  });

  it('does not parse bash pipes inside fenced code blocks as tables', () => {
    const codeMarkdown = `\`\`\`bash
cat logs.txt | grep "ERROR" | awk '{print $2}'
\`\`\``;

    const { container } = render(<Markdown content={codeMarkdown} live={true} />);

    expect(container.querySelector('table')).toBeNull();
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('cat logs.txt | grep "ERROR"');
  });

  it('does not parse inline code with pipe characters as tables', () => {
    const inlineMarkdown = 'Use `cmd1 | cmd2` to pipe commands.';

    const { container } = render(<Markdown content={inlineMarkdown} live={true} />);

    expect(container.querySelector('table')).toBeNull();
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('cmd1 | cmd2');
  });

  it('does not parse standalone pipe characters in prose as tables', () => {
    const proseMarkdown = 'Select Option A | Option B | Option C for details.';

    const { container } = render(<Markdown content={proseMarkdown} live={true} />);

    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('Option A | Option B | Option C');
  });

  it('renders Copy button and wrapper chrome during live streaming (live=true)', () => {
    const codeMarkdown = `\`\`\`typescript
function calculateSum(a: number, b: number): number {
  return a + b;
}
\`\`\``;

    const { container } = render(<Markdown content={codeMarkdown} live={true} />);

    const wrapper = container.querySelector('.markdown-code-block');
    expect(wrapper).not.toBeNull();

    const button = container.querySelector('button.markdown-copy-btn');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('Copy');
  });

  it('maintains structural DOM parity for large code blocks between live=true and live=false', () => {
    const largeCodeMarkdown = `\`\`\`python
def process_data(items):
    results = []
    for item in items:
        if item.get("valid"):
            results.append(item["value"] * 2)
    return results

print(process_data([{"valid": True, "value": 10}]))
\`\`\``;

    const { container: liveContainer } = render(<Markdown content={largeCodeMarkdown} live={true} />);
    const { container: finalContainer } = render(<Markdown content={largeCodeMarkdown} live={false} />);

    // Wrapper, pre, code, button chrome must be identical
    expect(liveContainer.querySelectorAll('.markdown-code-block').length).toBe(1);
    expect(finalContainer.querySelectorAll('.markdown-code-block').length).toBe(1);

    expect(liveContainer.querySelectorAll('pre').length).toBe(1);
    expect(finalContainer.querySelectorAll('pre').length).toBe(1);

    expect(liveContainer.querySelectorAll('code').length).toBe(1);
    expect(finalContainer.querySelectorAll('code').length).toBe(1);

    expect(liveContainer.querySelectorAll('button.markdown-copy-btn').length).toBe(1);
    expect(finalContainer.querySelectorAll('button.markdown-copy-btn').length).toBe(1);

    // Text content must match line-for-line
    expect(liveContainer.querySelector('code')?.textContent).toBe(finalContainer.querySelector('code')?.textContent);
  });

  it('renders KaTeX math expressions identically during live=true and live=false', () => {
    const mathMarkdown = 'Inline math: $E = mc^2$\n\nDisplay math:\n$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$';

    const { container: liveContainer } = render(<Markdown content={mathMarkdown} live={true} />);
    const { container: finalContainer } = render(<Markdown content={mathMarkdown} live={false} />);

    const liveKatex = liveContainer.querySelectorAll('.katex');
    const finalKatex = finalContainer.querySelectorAll('.katex');

    expect(liveKatex.length).toBe(2);
    expect(finalKatex.length).toBe(2);
    expect(liveKatex.length).toEqual(finalKatex.length);
    expect(liveContainer.querySelector('.katex')?.innerHTML).toBe(finalContainer.querySelector('.katex')?.innerHTML);
  });

  it('maintains structural DOM parity between live=true and live=false for tables and lists', () => {
    const markdownText = `
### Summary
- Item 1
- Item 2

| Key | Value |
| --- | --- |
| Status | Active |
`;

    const { container: liveContainer } = render(<Markdown content={markdownText} live={true} />);
    const { container: finalContainer } = render(<Markdown content={markdownText} live={false} />);

    expect(liveContainer.querySelectorAll('h3').length).toBe(1);
    expect(finalContainer.querySelectorAll('h3').length).toBe(1);

    expect(liveContainer.querySelectorAll('ul').length).toBe(1);
    expect(finalContainer.querySelectorAll('ul').length).toBe(1);

    expect(liveContainer.querySelectorAll('li').length).toBe(2);
    expect(finalContainer.querySelectorAll('li').length).toBe(2);

    expect(liveContainer.querySelectorAll('table').length).toBe(1);
    expect(finalContainer.querySelectorAll('table').length).toBe(1);

    expect(liveContainer.querySelectorAll('th').length).toBe(2);
    expect(finalContainer.querySelectorAll('th').length).toBe(2);
  });

  it('profiles memoized KaTeX rendering cost per flush across repeated stream updates', () => {
    const mathContent = `
Inline math 1: $E = mc^2$
Inline math 2: $\\alpha + \\beta = \\gamma$
Inline math 3: $\\int_{0}^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$
Inline math 4: $A = \\pi r^2$
Inline math 5: $f(x) = \\sqrt{x^2 + y^2}$

Display matrix math:
$$\\begin{pmatrix} a_{11} & a_{12} & a_{13} \\\\ a_{21} & a_{22} & a_{23} \\\\ a_{31} & a_{32} & a_{33} \\end{pmatrix} \\begin{pmatrix} x_1 \\\\ x_2 \\\\ x_3 \\end{pmatrix} = \\begin{pmatrix} b_1 \\\\ b_2 \\\\ b_3 \\end{pmatrix}$$
`;

    // Warm up cache on 1st parse
    render(<Markdown content={mathContent} live={true} />);

    // Profile subsequent flushes when math equations are already in cache
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      render(<Markdown content={mathContent} live={true} />);
      const t1 = performance.now();
      times.push(t1 - t0);
    }

    const avgTimeMs = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`[KaTeX Cache Profiling] Average cached flush duration (5 inline + 1 matrix equation): ${avgTimeMs.toFixed(3)} ms`);
    expect(avgTimeMs).toBeLessThan(20);
  });
});
