import { memo, useId, useRef, useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SignalIcon } from '@/components/ui/SignalIcon';

/**
 * ThinkingDisclosure — auto-open while streaming, collapse when done
 *
 * Collapsible "Thinking" section that:
 * - Auto-opens while streaming (pending=true)
 * - Auto-collapses when done
 * - Shows elapsed time inline while streaming
 * - Scroll-locks to bottom during live preview
 */
interface ThinkingDisclosureProps {
  children: ReactNode;
  pending?: boolean;
  duration?: number;
  elapsed?: number;
  icon?: ReactNode;
  label?: string;
  /** When true, skip the "Thought for Xs" suffix (the activity summary
   *  already counts thoughts in its own total). */
  omitDurationLabel?: boolean;
}

export const ThinkingDisclosure = memo(function ThinkingDisclosure({
  children,
  pending = false,
  duration,
  elapsed,
  icon: _icon,
  label,
  // Kept in the signature: callers still pass it. The block shows the raw
  // duration instead of a composed sentence, so there is nothing to omit.
  omitDurationLabel: _omitDurationLabel = false,
}: ThinkingDisclosureProps) {
  const uid = useId();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // Claude-parity: done reasoning clamps to a short window with Show more.
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Auto-open while streaming; always collapse when generation finishes —
  // even if the user expanded the section mid-stream.
  const open = userOpen ?? pending;

  useEffect(() => {
    setUserOpen(null);
  }, [pending]);

  const isPreview = pending && userOpen === null;


  // Pin scroll to bottom during live preview
  useEffect(() => {
    if (!isPreview) return;
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    const pin = () => {
      el.scrollTop = el.scrollHeight;
    };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    return () => observer.disconnect();
  }, [isPreview, open, children]);

  const liveElapsed = pending && elapsed !== undefined ? fmtElapsed(elapsed) : null;
  const displayDuration =
    duration !== undefined ? fmtElapsed(duration) : liveElapsed;
  // Explicit multi-count label (e.g. "Thinking (3)") wins when provided.
  // Otherwise keep the classic single-thought labels.
  const bodyId = `thinking-body-${uid}`;
  const headerId = `thinking-head-${uid}`;

  return (
    <div className="thinking-block" data-open={open} data-slot="thinking-disclosure">
      <Button
        variant="bare"
        id={headerId}
        type="button"
        className="thinking-head"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <SignalIcon name="brain" className="brain" />
        <strong>{label != null && label !== '' ? label : 'Thinking'}</strong>
        {displayDuration ? <span className="duration">{displayDuration}</span> : null}
        <SignalIcon name="chev" className="chev" />
      </Button>

      <div
        className="thinking-body"
        id={bodyId}
        role="region"
        aria-labelledby={headerId}
        hidden={!open}
      >
        {/* Done reasoning clamps to a short window with Show more: long
            reasoning must never dominate the transcript. While streaming the
            live preview scroll-pins instead. */}
        {!pending && (
          <Button
            variant="bare"
            type="button"
            onClick={() => setExpanded((v) => !v)}
            data-testid="thinking-show-more"
            className="thinking-more"
          >
            {expanded ? 'Show less' : 'Show more'}
          </Button>
        )}
        <div
          ref={scrollRef}
          className={cn(
            'tool-result-scroll overscroll-contain thinking-scroll',
            pending ? 'max-h-36 overflow-y-auto' : expanded ? '' : 'relative max-h-16 overflow-hidden',
          )}
          onWheel={(e) => {
            if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) {
              e.stopPropagation();
            }
          }}
        >
          <div ref={contentRef}>{children}</div>
        </div>
      </div>
    </div>
  );
});

function fmtElapsed(sec: number): string {
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}
