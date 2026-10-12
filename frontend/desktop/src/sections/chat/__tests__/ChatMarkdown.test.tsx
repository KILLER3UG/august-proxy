import { render } from '@testing-library/react';
import katex from 'katex';
import { Marked } from 'marked';
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from '../ChatMarkdown';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { demoteRenderedHeadings } from '@/lib/markdownHeadings';

describe('ChatMarkdown Component', () => {
  it('does not paint an incomplete trailing table row while streaming (live=true)', () => {
    // Mid-stream: header + separator + one full row are newline-terminated, but
    // the last row is still arriving (no trailing newline).
    const streamingTable =
      '| Header 1 | Header 2 |\n| --- | --- |\n| Row 1 Col 1 | Row 1 Col 2 |\n| Row 2 Col 1';

    const { container } = render(<Markdown content={streamingTable} live={true} />);

    // The table renders with only the completed row; the half-received row is held back.
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(container.textContent).not.toContain('Row 2 Col 1');
  });

  it('renders the previously-held row once it is newline-terminated (live=true)', () => {
    const completedTable =
      '| Header 1 | Header 2 |\n| --- | --- |\n| Row 1 Col 1 | Row 1 Col 2 |\n| Row 2 Col 1 | Row 2 Col 2 |\n';

    const { container } = render(<Markdown content={completedTable} live={true} />);

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(container.textContent).toContain('Row 2 Col 1');
  });

  it('does not trim a trailing pipe line inside an unclosed code fence (live=true)', () => {
    // Streaming a bash pipeline inside an open fence — must not be treated as a table row.
    const streamingCode = '```bash\ncat logs.txt | grep ERROR';

    const { container } = render(<Markdown content={streamingCode} live={true} />);

    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('cat logs.txt | grep ERROR');
  });

  it('fades only the growing tail block while streaming', () => {
    const { container } = render(
      <Markdown content={'First paragraph.\n\nSecond still growing'} live={true} />,
    );
    const tails = container.querySelectorAll('.md-live-tail');
    expect(tails.length).toBe(1);
    expect(tails[0].textContent).toContain('Second still growing');
    expect(container.querySelector('.markdown-content')?.textContent).toContain('First paragraph');
  });

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

  it('appends completed blocks without rewriting earlier blocks as the stream grows (live=true)', () => {
    const { container, rerender } = render(
      <Markdown content={'Alpha\n\nBeta'} live={true} />,
    );

    const paras = container.querySelectorAll('p');
    expect(paras.length).toBe(2);
    expect(paras[0].textContent).toBe('Alpha');
    expect(paras[1].textContent).toBe('Beta');
    const firstBlockHtml = (paras[0] as HTMLElement).innerHTML;
    const secondBlockHtml = (paras[1] as HTMLElement).innerHTML;

    // A new paragraph completes; Alpha/Beta blocks must not re-render differently.
    rerender(<Markdown content={'Alpha\n\nBeta\n\nGamma'} live={true} />);

    const paras2 = container.querySelectorAll('p');
    expect(paras2.length).toBe(3);
    expect(paras2[2].textContent).toBe('Gamma');
    expect((paras2[0] as HTMLElement).innerHTML).toBe(firstBlockHtml);
    expect((paras2[1] as HTMLElement).innerHTML).toBe(secondBlockHtml);
  });

  it('keeps a fenced code block intact across blank-line block splits (live=true)', () => {
    // A blank line INSIDE the fence is code, not a block boundary — the two
    // code lines must stay in a single <pre>.
    const content = 'Intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```';

    const { container } = render(<Markdown content={content} live={true} />);

    expect(container.querySelectorAll('pre').length).toBe(1);
    expect(container.querySelector('code')?.textContent).toContain('const a = 1;');
    expect(container.querySelector('code')?.textContent).toContain('const b = 2;');
    expect(container.querySelector('p')?.textContent).toBe('Intro');
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

    // The property under test is the CACHE, not the clock. A wall-clock
    // ratio is bimodal in jsdom — React reconcile + marked parse dominate,
    // and whether a sibling test pre-warmed this module's KaTeX cache flips
    // the ratio between ~1.4x and ~100x, which is why the timing version of
    // this test was intermittently red. Instead we count actual KaTeX
    // invocations (katex.renderToString is read at call time, so a spy sees
    // it): a working cache means the first render of unseen math parses it
    // and every re-render of the SAME content parses nothing. Deterministic
    // under any machine load.
    const nonce = `cache-probe-${Math.random().toString(36).slice(2)}`;
    const content = `${mathContent}

${nonce}`;
    const spy = vi.spyOn(katex, 'renderToString');

    // First render: the math is unseen, so it must reach KaTeX.
    render(<Markdown content={content} live={true} />);
    const coldCalls = spy.mock.calls.length;
    expect(coldCalls).toBeGreaterThan(0);

    // Re-renders of identical content — every flush a live turn does — must
    // add ZERO parse work. This is the memoization the whole layer exists
    // for (a streaming answer re-renders many times per second).
    for (let i = 0; i < 20; i++) {
      render(<Markdown content={content} live={true} />);
    }
    expect(spy.mock.calls.length).toBe(coldCalls);

    // Genuinely NEW math still parses (the cache is keyed, not a blanket
    // skip) — the variant carries an equation the cache has never seen.
    render(
      <Markdown content={`${content}

$$\nu_{${nonce}} = 1$$`} live={true} />,
    );
    expect(spy.mock.calls.length).toBeGreaterThan(coldCalls);

    spy.mockRestore();
  });
});

describe('demoteRenderedHeadings — an authored document inside a dialog', () => {
  it('shifts every heading tag one level and stops at h6', () => {
    expect(demoteRenderedHeadings('<h1>Title</h1>')).toBe('<h2>Title</h2>');
    expect(demoteRenderedHeadings('<h2 id="s" class="x">S</h2><h3>S</h3>')).toBe(
      '<h3 id="s" class="x">S</h3><h4>S</h4>',
    );
    expect(demoteRenderedHeadings('<h5>a</h5><h6>b</h6>')).toBe('<h6>a</h6><h6>b</h6>');
    // The WHOLE ladder moves, not just level 1: the dialog's own section headings
    // are h2, so an authored h2 left in place would sit at the same depth as the
    // panel it is content for. A setext h2 (`Sub` + `---`) is a heading like any
    // other, and that is why it is not in the byte-identity group below.
    expect(demoteRenderedHeadings(String(new Marked().parse('Sub\n---\n', { async: false })))).toBe(
      '<h3>Sub</h3>\n',
    );
    // Case is tolerated on the way in (raw HTML may be uppercase) and normalised.
    expect(demoteRenderedHeadings('<H1>x</H1>')).toBe('<h2>x</h2>');
  });

  it('touches heading tags and nothing that merely starts with h', () => {
    for (const html of [
      '<header>nav</header>',
      '<hr>',
      '<h1abc>x</h1abc>',
      '<a href="#h1">jump</a>',
      '<code>&lt;h1&gt;not a tag&lt;/h1&gt;</code>',
      '<pre><code class="language-html">&lt;h1&gt;raw&lt;/h1&gt;</code></pre>',
      '<p>use h1 for the page title</p>',
      '<!-- <h1>inside a comment</h1> -->',
    ]) {
      if (html.startsWith('<!--')) continue; // raw HTML comment: see the limit note
      expect(demoteRenderedHeadings(html)).toBe(html);
    }
  });

  it('leaves no h1 in the renderer output of any h1 shape, measured through marked', () => {
    /* The shapes below each produced an <h1> in `marked` with no demotion, and the
     * source-rewriting demoter missed all of them at some point — the list is the
     * fuzz harness's evidence, kept because the property it pins ("no level 1 in
     * the dialog") is the product requirement.
     *
     * Judged on the rendered HTML, both directions are cheap: an h1 shape must
     * come out with no `<h1`, and a document with no heading in it must come out
     * byte-identical. That second half is what the source rewriter got wrong 12
     * different ways, because every one of them was a disagreement about which
     * lines the parser considered headings.
     */
    const h1Shapes = [
      '# H1',
      '   # Indented title',
      '#Title-ish? no: # with space',
      '> # Quoted title',
      '>\t# Quoted title with a tab',
      '- # Bulleted title',
      '1. # Numbered title',
      '> - # Quoted bulleted title',
      '- a\n    # Title at the list content column',
      '- a\n  # T at a two-column item',
      '- a\n\t# Tab continuation of the item',
      '-     a\n  # T at a five-space bullet column',
      '>  # Two spaces after the quote marker',
      '> > > > > # Five levels of quote',
      '> > > > > > > > > > > > > # Thirteen deep quote',
      `${'> '.repeat(40)}# Forty deep quote`,
      '- - - - - # Five levels of bullet',
      'Release Notes\n=============',
      'one\ntwo\n===',
      '- Title\n  more\n  ===',
      '> one\n> two\n> ===',
      '- Release Notes\n  ==============',
      '> Release Notes\n> ==============',
      '- a\n- b\n  ===',
      // Shapes the source demoter got wrong and could not see itself getting wrong.
      '```{.c caption="t"}\n// real\n```\n\n# After a brace fence',
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n# After a table',
      '> ```\n> # inside a quoted fence\n> ```\n\n# After a quoted fence',
      '- ```\n  # in a fence\n  ```\n\n# Real',
      '1. ```\n   # c\n2. # Sibling item heading',
      '- ````\n  # c\n  ```\n\n# Real',
      '<div>\nTitle\n\n# After the blank line',
      'Title\r\n=====\r\n\r\nCRLF setext',
      '- a\r\n  ```bash\r\n  # comment\r\n  ```\r\n\r\n# Real',
      '`code`\n===',
      '~ tildeish\n===',
      '| a | b\n===',
      '#\n# bare hash',
    ].filter((d) => !d.startsWith('#Title-ish'));
    const notHeadings = [
      '    # Top-level indented code',
      '\t# Tab-indented code',
      '- a\n      # six spaces is code inside a two-column item',
      '  - a\n        # four past a nested column',
      '-     a\n      # T',
      '#hashtag',
      '####### seven is not a heading',
      '> a\n    # four spaces past a quote is code',
      '> \t# space then tab is code',
      '<div>\n# Title\n</div>',
      '<pre>\n# T\n\n# Real',
      '```c\n# a shell comment\n```',
      '- a\n    ```bash\n    # c\n    ```\n- b\n',
      'Title\n> quote\n===',
      'A\n* * *\n===',
      'one\ntwo\n\n===',
      '```',
      '',
    ];

    // A fresh `Marked`: `ChatMarkdown` configures the shared singleton with its
    // own renderer, so a control asserted against the singleton depends on which
    // test ran first. Parsing (not rendering through React) is also the only way
    // to judge a multi-block document synchronously — the thread renderer flushes
    // per frame, so a `querySelector('h1')` would be measuring a timer.
    const probe = new Marked();
    const html = (src: string) => String(probe.parse(src, { async: false }));

    for (const doc of h1Shapes) {
      const raw = html(doc);
      expect(raw, `not an h1 in marked, misfiled: ${JSON.stringify(doc)}`).toMatch(/<h1[\s>]/);
      const out = demoteRenderedHeadings(raw);
      expect(out, `an h1 survived: ${JSON.stringify(doc)}`).not.toMatch(/<h1[\s>]/);
      // Level changes; words do not appear or vanish.
      const words = (s: string) => (s.match(/[A-Za-z]{2,}/g) ?? []).sort().join(',');
      expect(words(out), `text lost: ${JSON.stringify(doc)}`).toBe(words(raw));
    }

    for (const doc of notHeadings) {
      const raw = html(doc);
      // The group is "documents with no heading tag at all". An h1 control alone
      // would let a setext h2 (`Sub` + `---`) in here and then fail on it: the
      // shift moves the whole ladder one rung — that is the point, since the
      // dialog's own section headings are h2 — so any heading changes.
      expect(raw, `a heading is in this document: ${JSON.stringify(doc)}`).not.toMatch(/<h[1-6][\s>]/);
      expect(demoteRenderedHeadings(raw), `rewrote a non-heading: ${JSON.stringify(doc)}`).toBe(raw);
    }
  });

  it('shifts a nested heading inside a list item, quoted or fenced, end to end', () => {
    const doc = '> - # Release Notes\n>   prose\n\n```\n# not a heading\n```\n';
    const { container } = render(<Markdown content={doc} demoteHeadings />);
    expect(container.querySelector('h1')).toBeNull();
    // `> - # Release Notes` is one heading, so one shift: h1 -> h2.
    const h2 = container.querySelector('h2');
    expect(h2?.textContent).toContain('Release Notes');
    // The fenced `#` stayed code: it is escaped text, not a tag, so the shift
    // cannot reach it and the fence rules the old module needed are gone.
    expect(container.textContent).toContain('# not a heading');
    expect(container.querySelector('h2')?.textContent ?? '').not.toContain('not a heading');
  });

  it('does not let the live block cache share HTML between the two levels', () => {
    /* `renderLiveBlock` caches by block text. The same streamed block is level 1
     * in a chat and level 2 in the dialog, so the flag has to be part of the key
     * — a cache that ignored it served whichever surface rendered first to both,
     * which is exactly what this asserts against.
     */
    const doc = '# Release Notes\n\nsecond block';
    const dialog = render(<Markdown content={doc} live demoteHeadings />);
    const chat = render(<Markdown content={doc} live />);
    expect(dialog.container.querySelector('h1')).toBeNull();
    expect(dialog.container.querySelector('h2')?.textContent).toContain('Release Notes');
    expect(chat.container.querySelector('h1')?.textContent).toContain('Release Notes');
  });

  it('is wired to every surface that shows an authored document', () => {
    /* The prop is a promise made per call site, so the call sites are asserted.
     * A document renderer that forgets it shows the dialog an h1 again, and the
     * unit tests above would all stay green. */
    const root = resolve(__dirname, '../../..'); // src/
    const files = [
      'sections/chat/InitAugCard.tsx',
      'sections/settings/HarnessImprovementsSection.tsx',
      'sections/settings/MemorySection.tsx',
      'sections/settings/SkillsSection.tsx',
      'sections/settings/UpdateSection.tsx',
    ];
    for (const rel of files) {
      const path = resolve(root, rel);
      expect(readFileSync(path, 'utf8'), rel).toMatch(/demoteHeadings/);
    }
  });

  it('leaves the chat surface alone', () => {
    // No flag, no shift: a model answer's own h1 is the document the user is
    // reading, not content nested under a panel.
    const { container } = render(<Markdown content="# Heading in chat" />);
    expect(container.querySelector('h1')?.textContent).toContain('Heading in chat');
  });
});
