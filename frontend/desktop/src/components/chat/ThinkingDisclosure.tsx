import { useRef, useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { DisclosureRow } from '@/components/chat/DisclosureRow';

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
  /** When true, skip the "Thought for Xs" suffix (ToolSummary already counts thoughts). */
  omitDurationLabel?: boolean;
}

export function ThinkingDisclosure({
  children,
  pending = false,
  duration,
  elapsed,
  icon,
  label,
  omitDurationLabel = false,
}: ThinkingDisclosureProps) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // New thinking starts open so the user sees it as it streams. Once it stops
  // streaming, auto-collapse it unless the user explicitly opened it.
  const open = userOpen ?? pending;

  useEffect(() => {
    if (pending) setUserOpen(null);
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
  // Explicit multi-count label (e.g. "Thinking (3)") wins when provided.
  // Otherwise keep the classic single-thought labels.
  const displayLabel =
    label != null && label !== ''
      ? pending && liveElapsed
        ? `${label} ${liveElapsed}`
        : label
      : pending
        ? liveElapsed
          ? `Thinking ${liveElapsed}`
          : 'Thinking'
        : duration !== undefined && !omitDurationLabel
          ? `Thought for ${fmtElapsed(duration)}`
          : omitDurationLabel && !pending
            ? 'Thought'
            : 'Thought';

  return (
    <div
      className="text-[12.5px] text-muted-foreground/70"
      data-slot="thinking-disclosure"
    >
      <DisclosureRow
        onToggle={() => setUserOpen(!open)}
        open={open}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          {icon}
          <span
            className={cn(
              'text-[12.5px] font-normal leading-5',
              pending
                ? 'text-muted-foreground/85 shimmer thinking-content-generating'
                : 'text-muted-foreground/55',
            )}
          >
            <span className={cn('thinking-text', pending && 'animating')}>
              <span className="thinking-label" style={{ whiteSpace: 'pre' }}>
                {displayLabel}
              </span>
              {pending && (
                <span className="thinking-dots">
                  <span className="dot" style={{ animationDelay: '0ms' }}>.</span>
                  <span className="dot" style={{ animationDelay: '200ms' }}>.</span>
                  <span className="dot" style={{ animationDelay: '400ms' }}>.</span>
                </span>
              )}
            </span>
          </span>
        </span>
      </DisclosureRow>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="thinking-content"
            initial={pending ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={pending ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={
              pending
                ? { duration: 0.1, ease: 'easeOut' }
                : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }
            }
            className={cn(
              'mt-0.5 w-full min-w-0 max-w-full wrap-anywhere pb-1 text-muted-foreground/65',
            )}
          >
            <div
              ref={scrollRef}
              className="tool-result-scroll max-h-36 overflow-y-auto overscroll-contain thinking-scroll"
              onWheel={(e) => {
                if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) {
                  e.stopPropagation();
                }
              }}
            >
              <div ref={contentRef}>{children}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function fmtElapsed(sec: number): string {
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}
