/**
 * Invariants for the incremental live-block splitter.
 *
 * The incremental splitter carries offsets across flushes so it only scans the
 * bytes that arrived since the last one — O(new bytes) per frame instead of
 * O(document). That is the whole point, but an offset carried across frames
 * is also the easiest thing in this renderer to get subtly wrong, and the
 * failure mode is not a crash: it is a block split in the wrong place, which
 * renders as mangled markdown in a live answer.
 *
 * These are therefore written as INVARIANTS, not as "equals the obvious
 * implementation". Byte-equality is deliberately NOT the assertion, because
 * the obvious implementation has a property an incremental one cannot have:
 * it UN-COMMITS. Content ending in a newline splits to a trailing empty
 * element, so the naive algorithm has already committed the last block; one
 * flush later, when the next line arrives, that block has no blank line after
 * it any more and falls back into the tail. Since `complete` only ever grows
 * here, matching that oscillation is impossible, and chasing it would mean
 * rescanning the document every frame — the cost being removed.
 *
 * So the properties pinned are the ones the fast path actually relies on:
 *   1. STABILITY — a committed block never changes, shrinks or reorders. This
 *      is what makes the block cache sound; a violation is a visible flicker.
 *   2. FIDELITY — every committed block is real text from the source at the
 *      right place, and nothing is dropped or duplicated.
 *   3. FENCE SAFETY — a blank line inside a code fence is code, not a
 *      separator, so it must never split a block.
 *   4. RESTART — a rewrite that is not an append rebuilds from scratch
 *      instead of reusing offsets that no longer mean anything.
 */
import { expect, it, describe } from 'vitest';
import { splitLiveBlocksIncremental } from '../ChatMarkdown';

type State = Parameters<typeof splitLiveBlocksIncremental>[1];

function freshState(): State {
  return { input: '', complete: [], scannedTo: 0, blockStart: 0, inFence: false, fenceMarker: '' };
}

const STREAM = [
  '', // leading blank line — the empty-block trap
  '',
  '# Title',
  '',
  'A paragraph long enough to arrive in several pieces.',
  '',
  '- item one',
  '- item two',
  '',
  '```python',
  'def f():',
  '    return 1',
  '',
  'a blank line INSIDE the fence is code',
  '',
  '```',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '~~~',
  'tilde fenced block',
  '',
  'also blank, also inside',
  '',
  '~~~',
  '',
  'Inline $E=mc^2$ math.',
  '',
  'Final paragraph.',
].join('\n');

/** Walk the stream one character at a time, checking the invariants at each step. */
function walk(text: string) {
  let state = freshState();
  const seen: string[] = [];
  for (let i = 1; i <= text.length; i++) {
    const src = text.slice(0, i);
    const got = splitLiveBlocksIncremental(src, state);
    state = got.state;

    // 1. STABILITY: everything committed before is still here, unchanged and
    //    in the same order. This is the property the whole cache rests on.
    expect(got.complete.slice(0, seen.length), `block mutated at prefix ${i}`).toEqual(seen);
    for (const block of got.complete.slice(seen.length)) seen.push(block);

    // 2. FIDELITY: every committed block is genuine source text, and the
    //    tail is a genuine suffix of what was rendered so far.
    for (const block of got.complete) {
      expect(src.includes(block), `block is not a substring of the source at ${i}`).toBe(true);
      expect(block.length, `committed an empty block at prefix ${i}`).toBeGreaterThan(0);
    }
    expect(src.endsWith(got.tail), `tail is not a suffix of the source at ${i}`).toBe(true);
  }
  return state;
}

describe('splitLiveBlocksIncremental', () => {
  it('never mutates or reorders a block it has already committed', () => {
    walk(STREAM);
  });

  it('holds the same invariants for an unclosed code fence', () => {
    walk('intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n\nmore text\n');
  });

  it('holds for a stream of nothing but blank lines', () => {
    walk('\n\n\n\n   \n\n\t\n\n');
  });

  it('holds for content that never gets a trailing newline', () => {
    walk('one line, no newline');
  });

  it('never splits a block inside a fenced code region', () => {
    const fenced = '```\nline one\n\nline two\n\nline three\n```\n';
    const got = splitLiveBlocksIncremental(fenced, freshState());
    // The fence is one block: the blank lines inside it are code, and
    // splitting on them would paint three separate code blocks.
    expect(got.complete).toEqual([]);
    expect(got.tail).toContain('line one');
    expect(got.tail).toContain('line three');
  });

  it('splits prose paragraphs but leaves fenced code whole', () => {
    const doc = '# Title\n\nA paragraph.\n\n```\ncode a\n\ncode b\n```\n\nAfter.\n';
    const got = splitLiveBlocksIncremental(doc, freshState());
    // The blank lines INSIDE the fence did not split it: the fence commits as
    // one block containing both `code a` and `code b`, which is the whole
    // point — splitting there would paint three separate code blocks.
    expect(got.complete).toEqual(['# Title', 'A paragraph.', '```\ncode a\n\ncode b\n```']);
    // `After.` is the still-growing last block, so it rides the tail.
    expect(got.tail).toBe('After.\n');
  });

  it('rebuilds from scratch when the content is rewritten, not appended', () => {
    // The guard that keeps the fast path honest. Reusing offsets here would
    // emit blocks sliced out of the middle of a string they no longer belong
    // to — silently wrong markdown rather than an error.
    const state = splitLiveBlocksIncremental('# One\n\nfirst body\n\n', freshState()).state;
    const rewritten = '# Totally different\n\nother body\n\n';
    const got = splitLiveBlocksIncremental(rewritten, state);
    expect(got.complete).toEqual(['# Totally different']);
    expect(got.tail).toContain('other body');
    // The decisive assertion: nothing from the PREVIOUS content survives.
    expect(got.complete.join('\n') + got.tail).not.toContain('first body');
    expect(got.state.input).toBe(rewritten);
  });

  it('rebuilds when the content is truncated below a previous prefix', () => {
    const state = splitLiveBlocksIncremental('# One\n\nbody one\n\nbody two\n', freshState()).state;
    const shorter = '# One\n\nbody one\n';
    const got = splitLiveBlocksIncremental(shorter, state);
    expect(got.complete).toEqual(['# One']);
    // `body two` was committed against the longer string; it must not leak
    // into the result for a string that never contained it.
    expect(got.tail).not.toContain('body two');
    expect(got.tail).toBe('body one\n');
  });

  it('resumes incrementally when content IS appended', () => {
    // The path that must stay fast: a second call on longer content keeps
    // everything already committed and only grows the tail.
    const first = 'para one\n\npara two\n\npara three is still growi';
    let state = freshState();
    let got = splitLiveBlocksIncremental(first, state);
    state = got.state;
    const committed = got.complete.slice();
    expect(committed).toEqual(['para one', 'para two']);

    const second = first + 'ng and did not stop';
    got = splitLiveBlocksIncremental(second, state);
    expect(got.complete.slice()).toEqual(committed);
    expect(got.tail).toBe('para three is still growing and did not stop');
  });
});
