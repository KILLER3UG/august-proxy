/**
 * ActivitySummary — one collapsed line for an entire pre-final turn of work.
 *
 * Collapsed:  Thought (3) · Viewed (7) · Ran (1) · Used (1)  ⌄
 * Expanded:   full normal timeline (thinking, tool groups, commands) as children
 *
 * Used only after final output exists so the chat is not a stack of sections.
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export interface ActivitySummaryCounts {
  thoughtCount: number;
  /** Total tools (view + edit + run + other), optional aggregate. */
  toolsCount?: number;
  viewedCount?: number;
  editedCount?: number;
  ranCount?: number;
  usedCount?: number;
}

export interface ActivitySummaryProps extends ActivitySummaryCounts {
  /** Full normal timeline rendered when expanded. */
  children: ReactNode;
  /** Start expanded (default false — settled answers stay dense). */
  defaultOpen?: boolean;
  className?: string;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

export function buildActivityCountSegments(c: ActivitySummaryCounts): Array<{ key: string; text: string }> {
  const segs: Array<{ key: string; text: string }> = [];
  if (c.thoughtCount > 0) {
    segs.push({ key: 'thought', text: plural(c.thoughtCount, 'thought', 'thoughts') });
  }

  // Prefer fine buckets when any are provided; fall back to aggregate Tools (N).
  const hasBuckets =
    (c.viewedCount ?? 0) +
      (c.editedCount ?? 0) +
      (c.ranCount ?? 0) +
      (c.usedCount ?? 0) >
    0;

  if (hasBuckets) {
    if ((c.viewedCount ?? 0) > 0) {
      segs.push({ key: 'viewed', text: plural(c.viewedCount!, 'viewed', 'viewed') });
    }
    if ((c.editedCount ?? 0) > 0) {
      segs.push({ key: 'edited', text: plural(c.editedCount!, 'edited', 'edited') });
    }
    if ((c.ranCount ?? 0) > 0) {
      segs.push({ key: 'ran', text: plural(c.ranCount!, 'ran', 'ran') });
    }
    if ((c.usedCount ?? 0) > 0) {
      segs.push({ key: 'used', text: plural(c.usedCount!, 'used', 'used') });
    }
  } else if ((c.toolsCount ?? 0) > 0) {
    segs.push({ key: 'tools', text: plural(c.toolsCount!, 'tool', 'tools') });
  }

  return segs;
}

export function ActivitySummary({
  thoughtCount,
  toolsCount = 0,
  viewedCount = 0,
  editedCount = 0,
  ranCount = 0,
  usedCount = 0,
  children,
  defaultOpen = false,
  className,
}: ActivitySummaryProps) {
  const [open, setOpen] = useState(defaultOpen);
  const segments = buildActivityCountSegments({
    thoughtCount,
    toolsCount,
    viewedCount,
    editedCount,
    ranCount,
    usedCount,
  });

  if (segments.length === 0) return null;

  return (
    <div
      className={cn('activity-summary', open && 'activity-summary--open', className)}
      data-slot="activity-summary"
      data-expanded={open ? 'true' : 'false'}
    >
      <button
        type="button"
        className="activity-summary-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="activity-summary-counts">
          {segments.map((s, i) => (
            <span key={s.key}>
              {i > 0 && (
                <span className="activity-summary-sep" aria-hidden>
                  {' '}
                  ·{' '}
                </span>
              )}
              {s.text}
            </span>
          ))}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="activity-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="activity-summary-body">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
