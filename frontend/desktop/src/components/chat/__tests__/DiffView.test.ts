/* ── DiffView.test.ts ─ unit tests for the diff/parser helpers ─────── */

import { describe, it, expect } from 'vitest';
import { diffLines, parseUnifiedDiff, diffStats } from '../DiffView';

describe('diffLines — same content', () => {
  it('returns all context lines for identical text', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc');
    expect(lines.every(l => l.kind === 'context')).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it('handles empty strings', () => {
    expect(diffLines('', '')).toEqual([]);
  });
});

describe('diffLines — pure addition (new file / append)', () => {
  it('marks all new lines as added when old is empty', () => {
    const lines = diffLines('', 'a\nb\nc');
    expect(lines).toHaveLength(3);
    expect(lines.every(l => l.kind === 'added')).toBe(true);
    expect(lines.map(l => l.text)).toEqual(['a', 'b', 'c']);
    expect(lines.map(l => l.newLine)).toEqual([1, 2, 3]);
  });
});

describe('diffLines — pure deletion (file removed)', () => {
  it('marks all old lines as removed when new is empty', () => {
    const lines = diffLines('a\nb\nc', '');
    expect(lines).toHaveLength(3);
    expect(lines.every(l => l.kind === 'removed')).toBe(true);
    expect(lines.map(l => l.text)).toEqual(['a', 'b', 'c']);
    expect(lines.map(l => l.oldLine)).toEqual([1, 2, 3]);
  });
});

describe('diffLines — middle edit (the common case)', () => {
  it('preserves common prefix and suffix, marks middle as removed+added', () => {
    const oldText = 'a\nb\nc\nd\ne';
    const newText = 'a\nb\nX\nY\nd\ne';
    const lines = diffLines(oldText, newText);

    const kinds = lines.map(l => l.kind);
    expect(kinds).toEqual(['context', 'context', 'removed', 'added', 'added', 'context', 'context']);
    expect(lines[0]).toMatchObject({ text: 'a', oldLine: 1, newLine: 1 });
    expect(lines[1]).toMatchObject({ text: 'b', oldLine: 2, newLine: 2 });
    expect(lines[2]).toMatchObject({ kind: 'removed', text: 'c', oldLine: 3 });
    expect(lines[3]).toMatchObject({ kind: 'added', text: 'X', newLine: 3 });
    expect(lines[4]).toMatchObject({ kind: 'added', text: 'Y', newLine: 4 });
    expect(lines[5]).toMatchObject({ kind: 'context', text: 'd' });
    expect(lines[6]).toMatchObject({ kind: 'context', text: 'e' });
  });

  it('handles a single-line edit in the middle of a long file', () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    const newText = oldText.replace('line10', 'line10-CHANGED');
    const lines = diffLines(oldText, newText);

    const removed = lines.filter(l => l.kind === 'removed');
    const added = lines.filter(l => l.kind === 'added');
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0].text).toBe('line10');
    expect(added[0].text).toBe('line10-CHANGED');
    expect(removed[0].oldLine).toBe(10);
    expect(added[0].newLine).toBe(10);
  });

  it('handles a single-line insert', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nINSERTED\nc');
    expect(lines.map(l => l.kind)).toEqual(['context', 'context', 'added', 'context']);
  });

  it('handles a single-line delete', () => {
    const lines = diffLines('a\nb\nc\nd', 'a\nb\nd');
    expect(lines.map(l => l.kind)).toEqual(['context', 'context', 'removed', 'context']);
  });
});

describe('diffLines — complete rewrite', () => {
  it('marks every line when prefix and suffix are both zero', () => {
    const lines = diffLines('x\ny\nz', '1\n2\n3');
    // No common prefix or suffix → all lines are paired removed/added
    expect(lines.every(l => l.kind === 'removed' || l.kind === 'added')).toBe(true);
    expect(lines.filter(l => l.kind === 'removed').map(l => l.text)).toEqual(['x', 'y', 'z']);
    expect(lines.filter(l => l.kind === 'added').map(l => l.text)).toEqual(['1', '2', '3']);
  });
});

describe('parseUnifiedDiff — basic', () => {
  it('parses a minimal unified diff', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\n');
    const lines = parseUnifiedDiff(diff);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ kind: 'context', text: 'a', oldLine: 1, newLine: 1 });
    expect(lines[1]).toMatchObject({ kind: 'removed', text: 'b', oldLine: 2 });
    expect(lines[2]).toMatchObject({ kind: 'added', text: 'B', newLine: 2 });
    expect(lines[3]).toMatchObject({ kind: 'context', text: 'c', oldLine: 3, newLine: 3 });
  });

  it('handles multiple hunks', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '@@ -10,2 +10,2 @@',
      ' x',
      '-y',
      '+Y',
    ].join('\n');
    const lines = parseUnifiedDiff(diff);
    const removed = lines.filter(l => l.kind === 'removed').map(l => l.text);
    const added = lines.filter(l => l.kind === 'added').map(l => l.text);
    expect(removed).toEqual(['b', 'y']);
    expect(added).toEqual(['B', 'Y']);
  });

  it('handles hunk headers with section labels (the optional trailing text)', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,3 @@ fn main()',
      ' a',
      '-b',
      '+B',
    ].join('\n');
    const lines = parseUnifiedDiff(diff);
    expect(lines).toHaveLength(3);
    expect(lines[1].kind).toBe('removed');
    expect(lines[2].kind).toBe('added');
  });

  it('ignores diff content before the first hunk header', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      'index 1234..5678 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const lines = parseUnifiedDiff(diff);
    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe('removed');
    expect(lines[1].kind).toBe('added');
  });

  it('returns empty for non-diff text', () => {
    expect(parseUnifiedDiff('hello world')).toEqual([]);
  });

  it('treats a line with no prefix as context', () => {
    const diff = [
      '--- a/f',
      '+++ b/f',
      '@@ -1,2 +1,2 @@',
      ' context',
      '-removed',
      '+added',
    ].join('\n');
    const lines = parseUnifiedDiff(diff);
    expect(lines[0]).toMatchObject({ kind: 'context', text: 'context' });
  });
});

describe('diffStats — +N -M summary for Task rows', () => {
  it('counts additions and removals from old/new content', () => {
    expect(diffStats({ oldContent: 'a\nb\nc', newContent: 'a\nX\nY\nc' })).toEqual({
      added: 2,
      removed: 1,
    });
  });

  it('counts from a unified diff string', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' a',
      '-b',
      '+B',
      '+B2',
      ' c',
    ].join('\n');
    expect(diffStats({ diff })).toEqual({ added: 2, removed: 1 });
  });

  it('returns null for null/empty payloads', () => {
    expect(diffStats(null)).toBeNull();
    expect(diffStats({})).toBeNull();
    expect(diffStats({ oldContent: 'same', newContent: 'same' })?.added).toBe(0);
  });
});
