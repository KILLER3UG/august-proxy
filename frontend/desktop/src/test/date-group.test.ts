/* ── date grouping ───────────────────────────────────────────────────────────
 * Shared by the sidebar and the history page so a chat filed under "Today" in
 * one is under "Today" in the other.
 *
 * The two properties that matter and are easy to break:
 *   1. It does NOT sort. It is a single pass over an already-ordered list, so
 *      a folder or pool keeps whatever order the user chose. Sorting inside
 *      the helper would silently reorder a name-sorted pool.
 *   2. It buckets contiguously. The same date appearing twice non-adjacently
 *      yields TWO headers rather than being merged, which is what keeps
 *      property 1 true.
 */

import { describe, it, expect } from 'vitest';
import { dateGroupLabel, groupByDate } from '@/lib/date-group';

const DAY = 86_400_000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

describe('dateGroupLabel', () => {
  it('names the two nearest days', () => {
    expect(dateGroupLabel(isoDaysAgo(0))).toBe('Today');
    expect(dateGroupLabel(isoDaysAgo(1))).toBe('Yesterday');
  });

  it('formats older dates rather than naming them', () => {
    const label = dateGroupLabel(isoDaysAgo(9));
    expect(label).not.toBe('Today');
    expect(label).not.toBe('Yesterday');
    expect(label.length).toBeGreaterThan(0);
  });

  it('returns Unknown for missing or invalid input instead of throwing', () => {
    // A session with a corrupt timestamp must still be listed somewhere.
    expect(dateGroupLabel('')).toBe('Unknown');
    expect(dateGroupLabel(null)).toBe('Unknown');
    expect(dateGroupLabel(undefined)).toBe('Unknown');
    expect(dateGroupLabel('not-a-date')).toBe('Unknown');
  });
});

describe('groupByDate', () => {
  it('buckets adjacent same-day items into one group', () => {
    const groups = groupByDate(
      [
        { id: 'a', at: isoDaysAgo(0) },
        { id: 'b', at: isoDaysAgo(0) },
      ],
      (x) => x.at,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Today');
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('does NOT sort — the caller owns the order', () => {
    // Deliberately oldest-first. A helper that sorted would reverse this.
    const groups = groupByDate(
      [
        { id: 'old', at: isoDaysAgo(5) },
        { id: 'new', at: isoDaysAgo(0) },
      ],
      (x) => x.at,
    );
    expect(groups.map((g) => g.label)).toEqual([groups[0].label, 'Today']);
    expect(groups[0].items[0].id).toBe('old');
    expect(groups[1].items[0].id).toBe('new');
  });

  it('splits a repeated date into two headers when not adjacent', () => {
    // This is the direct consequence of not sorting: contiguity is preserved
    // even when it means the same label appears twice.
    const groups = groupByDate(
      [
        { id: 't1', at: isoDaysAgo(0) },
        { id: 'old', at: isoDaysAgo(4) },
        { id: 't2', at: isoDaysAgo(0) },
      ],
      (x) => x.at,
    );
    expect(groups).toHaveLength(3);
    expect(groups[0].label).toBe('Today');
    expect(groups[1].label).not.toBe('Today');
    expect(groups[2].label).toBe('Today');
  });

  it('returns an empty list for an empty pool', () => {
    expect(groupByDate([], () => isoDaysAgo(0))).toEqual([]);
  });

  it('keeps invalid timestamps in a trailing Unknown bucket', () => {
    const groups = groupByDate(
      [
        { id: 'ok', at: isoDaysAgo(0) },
        { id: 'bad', at: 'nope' },
      ],
      (x) => x.at,
    );
    expect(groups).toHaveLength(2);
    expect(groups[1].label).toBe('Unknown');
    expect(groups[1].items[0].id).toBe('bad');
  });
});
