/* ── ValuePill — Haze's "13 px" pill ───────────────────────────────────
 *
 * A labelled value that opens a menu, drawn as ONE outlined pill showing the
 * current value. The reference (Haze's Appearance pane) uses exactly this for
 * each per-surface font size; a native <select> was the old shape here and it
 * rendered with the OS chrome, which is the loudest element on a page that is
 * supposed to be four quiet rows.
 *
 * Why a menu and not a select: the row has to read as `label ........ [13 px]`
 * at rest. A closed select shows the platform's own dropdown affordance and
 * ignores the theme; this keeps one visual language across the whole pane.
 *
 * The trigger is a real <button> with `aria-haspopup`, and the menu is a
 * Radix dropdown, so roving focus, Escape and outside-click all come for free —
 * none of it is reimplemented here.
 */

import { Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface ValuePillOption<T extends string | number> {
  value: T;
  label: string;
}

export function ValuePill<T extends string | number>({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  /** Accessible name for the trigger — "Interface font size". */
  ariaLabel: string;
  value: T;
  options: ReadonlyArray<ValuePillOption<T>>;
  onChange: (value: T) => void;
}) {
  const current = options.find((o) => o.value === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex h-7 min-w-16 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 text-xs tabular-nums text-foreground transition hover:border-ring/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {current?.label ?? String(value)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-24">
        {options.map((option) => (
          <DropdownMenuItem
            key={String(option.value)}
            onSelect={() => onChange(option.value)}
            className="flex items-center justify-between gap-3 text-xs tabular-nums"
          >
            {option.label}
            {option.value === value ? <Check className="size-3 text-muted-foreground" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}