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
 * - Shows elapsed timer while streaming
 * - Scroll-locks to bottom during live preview
 */
interface ThinkingDisclosureProps {
  children: ReactNode;
  pending?: boolean;
  duration?: number;
  elapsed?: number;
  icon?: ReactNode;
  label?: string;
}

export function ThinkingDisclosure({
  children,
  pending = false,
  duration,
  elapsed,
  icon,
  label = 'Thinking',
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

  const displayLabel = pending
    ? 'Thinking'
    : duration !== undefined
      ? `Thought for ${fmtElapsed(duration)}`
      : label;

  const displayDuration = pending
    ? elapsed !== undefined ? fmtElapsed(elapsed) : null
    : null;

  return (
    <div
      className="text-sm text-muted-foreground"
      data-slot="thinking-disclosure"
    >
      <DisclosureRow
        onToggle={() => setUserOpen(!open)}
        open={open}
        trailing={
          displayDuration && (
            <span className="font-mono text-[12px] text-muted-foreground/60 tabular-nums shrink-0">
              {displayDuration}
            </span>
          )
        }
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          {icon}
          <span
            className={cn(
              'text-sm font-medium leading-5',
              pending ? 'text-foreground/80 shimmer thinking-content-generating' : 'text-muted-foreground'
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
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'mt-0.5 w-full min-w-0 max-w-full overflow-hidden wrap-anywhere pb-1',
              isPreview && 'max-h-40'
            )}
            ref={scrollRef}
          >
            <div ref={contentRef}>{children}</div>
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
