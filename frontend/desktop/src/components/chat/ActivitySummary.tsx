/**
 * ActivitySummary — one collapsed line for an entire pre-final turn of work.
 *
 * Collapsed:  prose gist (or Thought · Viewed · Ran counts)  ⌄
 * Expanded:   full normal timeline (thinking, tool groups, commands) as children
 *
 * Used only after final output exists so the chat is not a stack of sections.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';
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
  /** §9 completion tally — distinct files touched, searches run, commands run. */
  filesTouched?: number;
  searches?: number;
  commands?: number;
  /** Tool calls that errored — renders an alert accent on the completion bar. */
  errors?: number;
}

export interface ActivitySummaryProps extends ActivitySummaryCounts {
  /** Full normal timeline rendered when expanded. */
  children: ReactNode;
  /**
   * Optional prose one-liner (from thinking). When set, it is the primary
   * collapsed label.
   */
  summary?: string | null;
  /** Optional “Thought for 2.7s” style meta when settled. */
  durationLabel?: string | null;
  /** Start expanded (while the turn is still working, before final output). */
  defaultOpen?: boolean;
  /** When true, show a live “still working” line even while collapsed. */
  live?: boolean;
  /** Short live status, e.g. “Reading src/app.ts”. */
  liveDetail?: string | null;
  /**
   * When this becomes true (e.g. final answer started), collapse the pack so
   * the chat focuses on the response. User can still re-expand manually.
   */
  collapseWhen?: boolean;
  /**
   * 'activity' — legacy counts/prose header.
   * 'completion' — §9 bar: chevron · bold "Task completed" · muted aggregate
   * tally ("1 file, 1 search, and 1 command") · elapsed time on the right.
   */
  mode?: 'activity' | 'completion';
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

/**
 * §9 aggregate description — tally what actually happened in the turn:
 * "1 file, 1 search, and 1 command". Zero counts are omitted; empty string
 * when nothing was tallied.
 */
export function buildCompletionSummary(c: ActivitySummaryCounts): string {
  const parts: string[] = [];
  if ((c.filesTouched ?? 0) > 0) parts.push(plural(c.filesTouched!, 'file', 'files'));
  if ((c.searches ?? 0) > 0) parts.push(plural(c.searches!, 'search', 'searches'));
  if ((c.commands ?? 0) > 0) parts.push(plural(c.commands!, 'command', 'commands'));
  if (parts.length === 0) {
    return (c.toolsCount ?? 0) > 0 ? plural(c.toolsCount!, 'step', 'steps') : '';
  }
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

export function ActivitySummary({
  thoughtCount,
  toolsCount = 0,
  viewedCount = 0,
  editedCount = 0,
  ranCount = 0,
  usedCount = 0,
  filesTouched = 0,
  searches = 0,
  commands = 0,
  errors = 0,
  children,
  summary,
  durationLabel,
  defaultOpen = false,
  live = false,
  liveDetail = null,
  collapseWhen = false,
  mode = 'activity',
  className,
}: ActivitySummaryProps) {
  const [open, setOpen] = useState(defaultOpen || live);
  const [bodyClip, setBodyClip] = useState(true);
  const wasLiveRef = useRef(live);
  useEffect(() => {
    if (open) setBodyClip(true);
  }, [open]);
  // While the turn is live (pre-final), keep the pack open so tools stay
  // visible in chat (not only in the Activity drawer).
  useEffect(() => {
    if (live && !collapseWhen) setOpen(true);
  }, [live, collapseWhen]);
  // As soon as the final response starts, collapse thinking/tools.
  useEffect(() => {
    if (collapseWhen) setOpen(false);
  }, [collapseWhen]);
  // If the user re-expanded during final generation, collapse again when
  // the turn fully finishes.
  useEffect(() => {
    if (wasLiveRef.current && !live) setOpen(false);
    wasLiveRef.current = live;
  }, [live]);
  const segments = buildActivityCountSegments({
    thoughtCount,
    toolsCount,
    viewedCount,
    editedCount,
    ranCount,
    usedCount,
  });
  const prose = summary?.trim() || '';
  const hasProse = prose.length > 0;
  const liveLine = (liveDetail || (live ? 'Working…' : '')).trim();
  const completionText = buildCompletionSummary({
    thoughtCount,
    toolsCount,
    filesTouched,
    searches,
    commands,
  });
  const isCompletion = mode === 'completion';

  // Activity mode needs something to say; the completion bar always renders
  // (the timeline only mounts it when the phase ran tool calls).
  if (!isCompletion && !hasProse && segments.length === 0 && !liveLine) return null;

  return (
    <div
      className={cn(
        'activity-summary',
        open && 'activity-summary--open',
        live && 'activity-summary--live',
        className,
      )}
      data-slot="activity-summary"
      data-mode={mode}
      data-expanded={open ? 'true' : 'false'}
      data-live={live ? 'true' : 'false'}
    >
      <button
        type="button"
        className="activity-summary-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {isCompletion ? (
          <>
            <ChevronDown
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
                open && 'rotate-180',
              )}
              aria-hidden
            />
            <span className="activity-summary-counts flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-semibold text-foreground">
                Task completed
              </span>
              {errors > 0 ? (
                <AlertCircle
                  className="size-3.5 shrink-0 text-danger"
                  aria-label="Some steps failed"
                />
              ) : null}
              {completionText ? (
                <span
                  className="min-w-0 truncate text-muted-foreground"
                  title={hasProse ? prose : undefined}
                >
                  {completionText}
                </span>
              ) : null}
            </span>
            {live && !open ? (
              <span
                className="activity-summary-header-live"
                data-testid="activity-summary-live-indicator"
                aria-label="Still working"
              >
                <span className="activity-summary-live-dot" aria-hidden />
              </span>
            ) : null}
            {durationLabel ? (
              <span className="activity-summary-duration" aria-hidden>
                {durationLabel}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="activity-summary-counts">
              {hasProse ? (
                <span className="activity-summary-prose" title={prose}>
                  {prose}
                </span>
              ) : (
                segments.map((s, i) => (
                  <span key={s.key}>
                    {i > 0 && (
                      <span className="activity-summary-sep" aria-hidden>
                        {' '}
                        ·{' '}
                      </span>
                    )}
                    {s.text}
                  </span>
                ))
              )}
              {durationLabel ? (
                <span className="activity-summary-duration" aria-hidden>
                  {hasProse || segments.length > 0 ? ' · ' : ''}
                  {durationLabel}
                </span>
              ) : null}
            </span>
            {/* Collapsed + live: pulse beside the chevron so the row still reads as working. */}
            {live && !open ? (
              <span
                className="activity-summary-header-live"
                data-testid="activity-summary-live-indicator"
                aria-label="Still working"
              >
                <span className="activity-summary-live-dot" aria-hidden />
              </span>
            ) : null}
            <ChevronDown
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
                open && 'rotate-180',
              )}
              aria-hidden
            />
          </>
        )}
      </button>

      {/* Always visible while live so collapse never looks like a freeze. */}
      {live && liveLine ? (
        <div className="activity-summary-live" aria-live="polite">
          <span className="activity-summary-live-dot" aria-hidden />
          <span className="truncate">{liveLine}</span>
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="activity-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={bodyClip ? 'overflow-hidden' : 'overflow-visible'}
            onAnimationStart={() => setBodyClip(true)}
            onAnimationComplete={() => setBodyClip(false)}
          >
            <div className="activity-summary-body">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
