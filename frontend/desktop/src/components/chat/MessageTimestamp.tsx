/* ── MessageTimestamp ────────────────────────────────────────────────────────
 * A relative age stamp that is ALWAYS visible, never hover-revealed.
 *
 * The owner's rule: minimalism is opt-in for telemetry the app *pushes*, but
 * always-on for detail the user *pulls*. A timestamp is pulled detail — you
 * look at a message to find out when it happened — and both reference UIs
 * show it without any pointer interaction. Hover-only would hide the answer
 * to the exact question the stamp exists to answer.
 *
 * Age is driven by ONE ticking context mounted once per thread rather than a
 * per-row interval. That is not an optimisation: `MessageBubble`'s memo
 * comparator (sections/chat/MessageBubble.tsx) returns *equal* for completed
 * tool-less rows, so a parent re-render does not refresh a prop-driven stamp
 * and the row would freeze at its first value forever. Context bypasses memo.
 *
 * Ticks stop once every row is older than the fixed-date threshold, because
 * `timeAgo()` degrades to a static absolute date past 7 days and a 30s
 * interval would then re-render the whole thread for a value that never
 * changes.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { absoluteDate, timeAgo } from '@/lib/utils';

/** Re-render cadence for relative ages. 30s keeps "3m ago" honest. */
const TICK_MS = 30_000;

/** `timeAgo()` returns a fixed date past this, so ticking becomes pointless. */
const MAX_RELATIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const TickerContext = createContext<number>(0);

/**
 * Mount ONCE per message pane. Children re-render on each tick via context,
 * which bypasses `MessageBubble`'s memo comparator (see the file header).
 *
 * Renders NO DOM of its own — a wrapper element inside the scroller would
 * become a layout participant and break `chat-scroll-content`'s flex sizing.
 * Children are returned as-is inside the provider.
 */
export function MessageTimestampTicker({
  newestTimestamp,
  children,
}: {
  /** Newest ISO timestamp in the thread — lets the ticker stop when idle. */
  newestTimestamp?: string | null;
  children: ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());

  // Stop once the newest row has aged out of relative range: every stamp in
  // the thread is a fixed date, so further ticks are pure churn.
  const newestMs = useMemo(() => {
    if (!newestTimestamp) return null;
    const t = new Date(newestTimestamp).getTime();
    return Number.isNaN(t) ? null : t;
  }, [newestTimestamp]);

  const live = newestMs !== null && now - newestMs < MAX_RELATIVE_AGE_MS;

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [live]);

  return <TickerContext.Provider value={now}>{children}</TickerContext.Provider>;
}

/** Relative age with the full absolute timestamp on hover/focus. */
export function MessageTimestamp({
  timestamp,
  className,
}: {
  timestamp: string | number | Date | null | undefined;
  className?: string;
}) {
  // Subscribe to the shared tick. Reading the context is what re-renders this
  // stamp when the age changes, despite the memo'd parent.
  useContext(TickerContext);

  const label = timeAgo(timestamp);
  if (!label) return null;

  const full = absoluteDate(timestamp);

  return (
    <span
      className={className ?? 'text-2xs tabular-nums text-muted-foreground'}
      title={full || undefined}
      data-testid="message-timestamp"
    >
      {label}
    </span>
  );
}
