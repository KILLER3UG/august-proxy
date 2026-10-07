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
  // eslint-disable-next-line no-useless-escape -- literal LaTeX source
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
  const steps = 40;
  const contents: string[] = [];
  for (let i = 1; i <= steps; i++) {
    contents.push(LONG_ANSWER.slice(0, Math.floor((LONG_ANSWER.length * i) / steps)));
  }

  // One round of both sides. Returns the pair so the caller can keep the
  // minimum per side.
  const round = () => {
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
    const mounted = render(<Markdown content={contents[0]} live={true} />);
    const t1 = performance.now();
    for (const c of contents.slice(1)) {
      mounted.rerender(<Markdown content={c} live={true} />);
    }
    const newMs = performance.now() - t1;
    const ok = mounted.container;
    mounted.unmount();
    return { legacyMs, newMs, ok };
  };

  // Contention is the whole problem. Vitest runs files in parallel, so a worker
  // that is starved adds time to whichever side waits on scheduling — and the
  // React side waits on scheduling while the parse side does not. That skews the
  // two sides UNEQUALLY, which is why a single round measured 1.99x on a loaded
  // runner and 5x on an idle one: the ratio below 2 was the machine, not the
  // renderer. Extra load can only ADD milliseconds, so the minimum of several
  // rounds is the load-tolerant estimate of each side, and the threshold stays
  // exactly where a real regression needs it.
  const rounds = 3;
  let legacyMs = Infinity;
  let newMs = Infinity;
  let container: Element | null = null;
  const samples: string[] = [];
  for (let r = 0; r < rounds; r++) {
    const m = round();
    samples.push(`${m.legacyMs.toFixed(0)}/${m.newMs.toFixed(0)}`);
    if (m.legacyMs < legacyMs) legacyMs = m.legacyMs;
    if (m.newMs < newMs) newMs = m.newMs;
    container = m.ok;
  }

  console.log(
    `[A.1 Perf] growing ${LONG_ANSWER.length}-char stream, ${steps} flushes × ${rounds} rounds — ` +
      `min legacy full-parse: ${legacyMs.toFixed(1)}ms, min block-cached live: ${newMs.toFixed(1)}ms ` +
      `(${(legacyMs / Math.max(newMs, 0.001)).toFixed(1)}x faster) rounds=${samples.join(' ')}`,
  );
  expect(container).toBeTruthy();

  // The property is a RATIO, not a duration. jsdom wall-clock scales with
  // whatever else the machine is doing — a loaded runner moved this from
  // ~640ms to ~36s, an 8x swing in the measured number while the code under
  // test did not change. An absolute ceiling therefore tests the machine
  // rather than the renderer, which is how this gate went red on the normal
  // path for as long as it existed.
  //
  // The ratio was believed load-independent, and that belief was wrong: it is
  // only independent if contention slows both sides equally, and it does not.
  // Measured on this tree, the same code produced 1.99x in a parallel run and
  // 5x in an isolated one, because the block-cached side spends its time in
  // React scheduling and is therefore the side that waits. Taking the minimum
  // of several rounds is what makes the ratio load-tolerant; the threshold
  // stays at 2 because that is where the regression it guards actually is.
  //
  // What it guards: before the incremental splitter the live path was SLOWER
  // than legacy (4196ms vs 6372ms — a ratio below 1). A 2x margin separates
  // that from the ~5x a working path shows.
  expect(legacyMs / Math.max(newMs, 0.001)).toBeGreaterThan(2);

  // One absolute number stays, as a tripwire against a genuine hang rather
  // than a slowdown: if either path stops finishing at all, no ratio helps.
  expect(Math.max(legacyMs, newMs)).toBeLessThan(120_000);
});
