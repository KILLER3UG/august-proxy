/**
 * A.1 live-markdown before/after measurement.
 *
 * Simulates a LONG streaming assistant answer (~17KB: many headings,
 * paragraphs, lists, tables, math, fenced code) arriving over ~120 flushes —
 * the late-stream stutter scenario from the smoothness plan:
 *
 *  - LEGACY: `renderMarkdown(content)` — full convertLatexToUnicode +
 *    marked.parse of the ENTIRE growing document every flush (the pre-A.1
 *    live path, minus DOM work — so this UNDERSTATES the old cost).
 *  - NEW: `<Markdown live content={content} />` mounted once and re-rendered
 *    per flush (like a real stream): completed blocks parse once and are
 *    cached; only the still-growing tail block re-parses, and React skips
 *    untouched blocks (DOM reconciliation included).
 *
 * Logs both totals + the ratio. This is a profiling diagnostic, not an SLO —
 * jsdom wall-clock varies with machine/CI load, so only a loose sanity
 * ceiling is asserted (catches a catastrophic regression, not normal jitter).
 */
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Markdown, renderMarkdown } from '../ChatMarkdown';

const _SECTION = [
  '# Shipping the feature pack',
  '',
  'This release focuses on streaming smoothness and cancel reliability. The',
  'workbench now streams live tool output, and Stop reliably kills child',
  'processes instead of abandoning them.',
  '',
  '## What changed',
  '',
  '- Live output streaming for run_command (heartbeat beats every 8s)',
  '- Generic tool progress beats while a tool is still working',
  '- Block-cached live markdown rendering (this renderer)',
  '- Offset-based terminal reconnect (no duplicate history)',
  '',
  '## Cancel matrix',
  '',
  '| Surface | Kills underlying work? |',
  '| --- | --- |',
  '| Chat Stop → shell | Yes — Event + close_process |',
  '| Chat Stop → LLM stream | Soft break on next chunk |',
  '| Chat Stop → DDGS | Yes on subprocess path |',
  '| Drawer close | Yes — PTY terminate |',
  '',
  'Inline math $E = mc^2$ and display math:',
  '',
  '$$\sum_{i=1}^n i = \frac{n(n+1)}{2}$$',
  '',
  '```python',
  'def process(items):',
  '    results = []',
  '    for item in items:',
  '        if item.get("valid"):',
  '            results.append(item["value"] * 2)',
  '    return results',
  '',
  'print(process([{"valid": True, "value": 10}]))',
  '```',
  '',
  '## Notes for the reviewer',
  '',
  'The legacy path re-parsed every complete paragraph on every flush; the new',
  'path renders each completed block exactly once and appends only the tail.',
  'Tables hold back a half-received row so they never paint cut borders.',
  '',
  'Final paragraph: the settle pass still produces the exact full-markdown',
  'parse, so nothing is lost — only the live painting is incremental.',
].join('\n');

// A long answer repeats section structure many times — that is exactly the
// late-stream case where the old path re-parsed everything on every flush.
const LONG_ANSWER = Array.from({ length: 12 }, () => _SECTION).join('\n\n---\n\n');

it('profiles legacy full-parse vs block-cached live render across a growing stream', () => {
  const steps = 120;
  const contents: string[] = [];
  for (let i = 1; i <= steps; i++) {
    contents.push(LONG_ANSWER.slice(0, Math.floor((LONG_ANSWER.length * i) / steps)));
  }

  // LEGACY: full convert + marked.parse of the whole document per flush PLUS
  // the whole-tree innerHTML replace the old component performed (React set
  // dangerouslySetInnerHTML on the root div every flush). The pre-A.1 live
  // path did both of these on every ~32ms flush.
  const t0 = performance.now();
  for (const c of contents) {
    const div = document.createElement('div');
    div.innerHTML = renderMarkdown(c);
  }
  const legacyMs = performance.now() - t0;

  // NEW: block-cached live renderer (parse once per completed block, DOM
  // reconciliation included — React skips untouched blocks). Mount once and
  // re-render with each growing content, exactly like a real stream flush.
  const { container, rerender } = render(<Markdown content={contents[0]} live={true} />);
  const t1 = performance.now();
  for (const c of contents.slice(1)) {
    rerender(<Markdown content={c} live={true} />);
  }
  const newMs = performance.now() - t1;

  console.log(
    `[A.1 Perf] growing ${LONG_ANSWER.length}-char stream, ${steps} flushes — ` +
      `legacy full-parse: ${legacyMs.toFixed(1)}ms, block-cached live: ${newMs.toFixed(1)}ms ` +
      `(${(legacyMs / Math.max(newMs, 0.001)).toFixed(1)}x faster)`,
  );
  expect(container).toBeTruthy();
  // Loose sanity ceiling: the incremental path must stay far below a
  // catastrophic hang even on loaded CI (120 jsdom renders of 8KB would
  // blow well past 10s if the tail-only parse + cache were broken).
  expect(newMs).toBeLessThan(5000);
});
