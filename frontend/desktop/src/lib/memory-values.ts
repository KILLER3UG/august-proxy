/* ── memory-values — the two encodings a brain memory row carries ────── */
/* The Library (Settings → Memory) and the memory tools door render and patch
 * the SAME columns, and three of them are not plain strings:
 *
 *  • `facts.fact_value` is a plain sentence OR a JSON `{fact, details}` object,
 *    written that way by the model's `remember` tool and by bulk import. A
 *    caller that patches it with a bare sentence silently drops the details
 *    half, so the composition rule lives here and both doors call it.
 *  • `memory_store.value` (the KV notes store) is JSON-encoded on write, so a
 *    read that does not decode shows a person `“"a sentence"”` where the note
 *    is a sentence.
 *  • Every SQLite stamp is `datetime('now')` — UTC, serialised as
 *    `YYYY-MM-DD HH:MM:SS` with NO zone marker, which JS then reads as LOCAL
 *    time. On a UTC+8 machine a fact learned two minutes ago rendered as
 *    "8h ago" and an expiry was judged eight hours early.
 *
 * Split out of MemorySection.tsx rather than copied, because a second
 * implementation of a storage encoding is how one of them quietly goes wrong.
 */

/** The facts store's two editor boxes: the summary column, and the details
 *  that are composed INTO that same column. Named once because both memory
 *  surfaces patch it, and an editor that gets the pairing wrong loses the
 *  details half of the value. */
export const FACTS_VALUE_FIELD = 'fact_value';
export const FACTS_DETAILS_FIELD = 'fact_details';

/** Tag a zone-less SQLite stamp as UTC before anything parses it. Only that
 *  exact shape is touched — a date-only ISO or a real offset passes through. */
export function asUtc(stamp: string): string {
  const s = (stamp || '').trim();
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
}

/** Parse an instant off a store stamp. NaN when the column is empty or junk —
 *  callers treat that as "no date", never as epoch. */
export function stampTime(stamp: unknown): number {
  const t = Date.parse(asUtc(typeof stamp === 'string' ? stamp : ''));
  return Number.isFinite(t) ? t : NaN;
}

function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** Unwrap `facts.fact_value` for display: the summary the row shows, and the
 *  details kept beside it. A value that is not the `{fact, details}` shape is
 *  the summary by itself. */
export function parseFactValue(raw: unknown): { summary: string; details?: string } {
  const s = text(raw);
  try {
    const obj = JSON.parse(s) as unknown;
    if (obj && typeof obj === 'object' && typeof (obj as Record<string, unknown>).fact === 'string') {
      const o = obj as Record<string, unknown>;
      return {
        summary: text(o.fact),
        details: typeof o.details === 'string' ? o.details : undefined,
      };
    }
    return { summary: s };
  } catch {
    return { summary: s };
  }
}

/** The inverse of `parseFactValue`, and the rule the read side already
 *  understands: a fact with details ships the JSON object, a fact without them
 *  stays a plain sentence — byte-identical to what the panel wrote before the
 *  details box existed. */
export function composeFactValue(summary: string, details: string): string {
  const s = summary.trim();
  const d = details.trim();
  return d ? JSON.stringify({ fact: s, details: d }) : s;
}

/** A KV note's summary is its first line, clamped — never the whole raw value
 *  (a legacy blob used to render 29 KB of JSON as one line). The full value
 *  (pretty-printed when it parses as JSON) rides in details. */
export function summarizeKvValue(raw: unknown): { summary: string; details: string } {
  const s = text(raw);
  const firstLine = (s.split('\n')[0] || '').trim();
  const summary =
    firstLine.length > 160 ? `${firstLine.slice(0, 160).trimEnd()}…` : firstLine || '(empty)';
  let details = s;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object') details = JSON.stringify(parsed, null, 2);
  } catch {
    /* not JSON — keep raw */
  }
  return { summary, details };
}

/** A day, not a timestamp: "Aug 21, 2026". The store's own stamp is UTC with
 *  no zone marker, so every getter here is the UTC one ON PURPOSE — formatting
 *  that instant in the machine's zone prints the previous calendar day for
 *  every user west of Greenwich. */
export function absoluteDay(stamp: string): string {
  const t = stampTime(stamp);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The row's right-hand date: "Updated Aug 21" this year, "Updated Aug 21,
 *  2025" when the memory is older. UTC for the same reason as `absoluteDay`. */
export function shortUpdated(stamp: string): string {
  const t = stampTime(stamp);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const now = new Date();
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return sameYear
    ? `Updated ${month} ${d.getUTCDate()}`
    : `Updated ${month} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
