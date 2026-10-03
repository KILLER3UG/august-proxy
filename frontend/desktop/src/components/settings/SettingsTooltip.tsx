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
  /** Custom trigger. When given, the caller's own element IS the hover/focus
   *  target and the `?` button is not rendered at all — a transcript chip is
   *  not a help-circle affordance, and adding one next to it would put two
   *  affordances where the user expects one. Spread the handed-back props
   *  onto that element; they are the whole contract (hover, focus, Escape,
   *  and the `aria-describedby` link to the bubble). */
  trigger?: (triggerProps: SettingsTooltipTriggerProps) => ReactNode;
}

/** What a custom trigger must spread to become a real tooltip target.
 *  Named locally (not exported) so this file stays a single-component module
 *  for react-refresh; callers get the shape from the callback parameter. */
interface SettingsTooltipTriggerProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  'aria-describedby': string | undefined;
}

export function SettingsTooltip({
  content,
  label = 'More info',
  side = 'top',
  className,
  trigger,
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

  const triggerProps: SettingsTooltipTriggerProps = {
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    onKeyDown: onKey,
    'aria-describedby': open ? id : undefined,
  };

  return (
    <span className={cn('relative inline-flex', className)}>
      {trigger ? (
        trigger(triggerProps)
      ) : (
        <button
          type="button"
          aria-label={label}
          className="inline-grid size-4 place-items-center rounded-full text-muted-foreground/70 transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          {...triggerProps}
          onClick={(e) => {
            // Click also toggles — useful on touch devices where hover isn't available.
            e.preventDefault();
            setOpen((o) => !o);
          }}
        >
          <HelpCircle className="size-3" />
        </button>
      )}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'absolute z-50 w-56 rounded-lg border border-border bg-popover px-3 py-2 text-2xs leading-4 text-popover-foreground shadow-md',
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
