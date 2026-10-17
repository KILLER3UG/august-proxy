/* ── History page date grouping ──────────────────────────────────────────────
 * The History page is a chronological archive, so it buckets by when a chat
 * STARTED. That is a deliberate choice there, not a limitation: `Session` also
 * carries `updatedAt` (last activity) as of 2026-10-17, and the sidebar orders
 * by it — but an archive grouped by "last activity" would move a 2024
 * conversation into this week because one message arrived late.
 *
 * Any label derived from this must say "started"/"by date", never "last
 * activity" — a chat you replied to this morning but opened three days ago
 * files under three days ago, and calling that "last activity" would be a lie
 * the UI tells quietly. (The sidebar no longer uses this helper; it groups by
 * project instead.)
 */

export interface DateGroup<T> {
  /** Display label: "Today", "Yesterday", or a formatted date. */
  label: string;
  items: T[];
}

/**
 * Human day label for a timestamp. "Today"/"Yesterday" for the two nearest
 * days, then a weekday + date for anything older. Invalid or missing input
 * returns "Unknown" rather than throwing — a session with a bad timestamp
 * must still be listed somewhere.
 */
export function dateGroupLabel(iso: string | number | Date | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return 'Unknown';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown';

  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * Group an already-sorted list into contiguous date buckets.
 *
 * The input MUST already be in the order it should display — this is a
 * single pass that only starts a new bucket when the label changes, which is
 * what keeps a folder's or pool's ordering intact. Sorting here instead would
 * silently reorder a pool whose order the user set.
 */
export function groupByDate<T>(
  items: readonly T[],
  stampOf: (item: T) => string | number | Date | null | undefined,
): DateGroup<T>[] {
  const groups: DateGroup<T>[] = [];
  for (const item of items) {
    const label = dateGroupLabel(stampOf(item));
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
