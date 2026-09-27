/**
 * The size-bounded caches behind the markdown renderer.
 *
 * These replaced entry-count caps. The reason is in SizedCache's docstring,
 * but the consequence worth pinning is behavioural: the budget must actually
 * BOUND memory, and it must do so without breaking the streaming path — a
 * cache that evicts the block currently being painted would silently undo the
 * incremental renderer and put the stutter straight back.
 */
import { expect, it, describe } from 'vitest';
import { SizedCache } from '../ChatMarkdown';

const byLength = (k: string, v: string) => k.length + v.length;

describe('SizedCache', () => {
  it('returns what it was given', () => {
    const c = new SizedCache<string, string>(1000, byLength);
    c.set('a', 'alpha');
    expect(c.get('a')).toBe('alpha');
    expect(c.get('missing')).toBeUndefined();
  });

  it('holds many small entries well inside the budget', () => {
    const c = new SizedCache<string, string>(10_000, byLength);
    for (let i = 0; i < 500; i++) c.set(`k${i}`, 'x');
    expect(c.size).toBe(500);
  });

  it('bounds memory when entries are large — the case a count cap missed', () => {
    // 40 entries of 5KB: a 300-entry count cap would have kept all 40 and
    // held 200 KB here, and would have kept every one of thousands.
    const c = new SizedCache<string, string>(20_000, byLength);
    for (let i = 0; i < 40; i++) c.set(`block-${i}`, 'y'.repeat(5_000));
    expect(c.approxChars).toBeLessThanOrEqual(20_000 + 10_000);
  });

  it('never exceeds the budget once warmed, however much is added', () => {
    const c = new SizedCache<string, string>(8_000, byLength);
    for (let i = 0; i < 2_000; i++) c.set(`k${i}`, 'z'.repeat(200));
    expect(c.approxChars).toBeLessThanOrEqual(8_000 + 400);
  });

  it('evicts oldest first, so the most recent work survives', () => {
    // Each entry costs ~105 chars (key + 100-char value), so a 250 budget
    // holds two and must drop the third-oldest to stay under.
    const c = new SizedCache<string, string>(250, byLength);
    c.set('first', 'a'.repeat(100));
    c.set('second', 'b'.repeat(100));
    expect(c.get('first')).toBe('a'.repeat(100));
    c.set('third', 'c'.repeat(100)); // over budget → 'first' goes
    expect(c.get('first')).toBeUndefined();
    expect(c.get('second')).toBe('b'.repeat(100));
    expect(c.get('third')).toBe('c'.repeat(100));
  });

  it('keeps a single oversized entry rather than emptying itself', () => {
    // The entry is the one being painted right now. Evicting it would only
    // guarantee a re-parse on the next frame, and an empty cache mid-render
    // is worse than a temporarily over-budget one.
    const c = new SizedCache<string, string>(100, byLength);
    c.set('huge', 'q'.repeat(10_000));
    expect(c.get('huge')).toBe('q'.repeat(10_000));
  });

  it('re-setting a key replaces rather than double-counts it', () => {
    const c = new SizedCache<string, string>(10_000, byLength);
    c.set('a', 'x'.repeat(100));
    c.set('a', 'x'.repeat(200));
    expect(c.size).toBe(1);
    expect(c.approxChars).toBe(1 + 200);
  });
});
