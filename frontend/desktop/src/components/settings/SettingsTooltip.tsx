/* ── SettingsTooltip — beginner-friendly ? tooltip ────────────────── */
/* Lightweight, dependency-free tooltip: shows a help bubble on hover/focus.
 * Keyboard accessible (focus + Escape to dismiss). Used wherever a setting
 * name might be unfamiliar to a new user. */

import {
  useState,
  useRef,
  useId,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SettingsTooltipProps {
  /** Plain-language explanation shown in the bubble. */
  content: ReactNode;
  /** Optional accessible label for the trigger; defaults to "More info". */
  label?: string;
  /** Side to anchor the bubble. */
  side?: 'top' | 'bottom';
  className?: string;
}

export function SettingsTooltip({
  content,
  label = 'More info',
  side = 'top',
  className,
}: SettingsTooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const timer = useRef<number | null>(null);

  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = () => {
    // Small delay so moving between the trigger and bubble doesn't flicker.
    timer.current = window.setTimeout(() => setOpen(false), 80);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <span className={cn('relative inline-flex', className)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        className="inline-grid size-4 place-items-center rounded-full text-muted-foreground/70 transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={onKey}
        onClick={(e) => {
          // Click also toggles — useful on touch devices where hover isn't available.
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        <HelpCircle className="size-3.5" />
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'absolute z-50 w-56 rounded-lg border border-border bg-popover px-3 py-2 text-[11px] leading-4 text-popover-foreground shadow-md',
            'pointer-events-none',
            side === 'top'
              ? 'bottom-full left-1/2 mb-1.5 -translate-x-1/2'
              : 'top-full left-1/2 mt-1.5 -translate-x-1/2',
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
