/* ── SettingsSelect — theme-safe dropdown for Settings forms ─────────── */
/* Custom listbox avoids Windows/WebView2 native <option> white-on-white.
 * Closed field matches Integrations field chrome; menu uses popover colors. */

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SettingsSelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SettingsSelectOption[];
  /** Accessible name when no visible label is associated */
  'aria-label'?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  /** Compact density for filter bars */
  size?: 'default' | 'sm';
}

export function SettingsSelect({
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
  id,
  disabled,
  className,
  size = 'default',
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-lg border border-white/[0.08]',
          'bg-card text-foreground shadow-none outline-none transition',
          'focus:border-primary/40 focus:ring-1 focus:ring-primary/30',
          'disabled:cursor-not-allowed disabled:opacity-50',
          size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-10 px-3 py-2 text-sm',
        )}
      >
        <span className="truncate text-left">{label}</span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={cn(
            'absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-white/[0.1]',
            'bg-popover py-1 text-popover-foreground shadow-lg',
          )}
        >
          {options.map((o) => {
            const isSelected = o.value === value;
            return (
              <li key={o.value} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition',
                    'text-foreground hover:bg-white/[0.06]',
                    isSelected && 'bg-primary/15 text-foreground',
                    size === 'sm' && 'py-1.5 text-xs',
                  )}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'size-3.5 shrink-0',
                      isSelected ? 'opacity-100 text-primary' : 'opacity-0',
                    )}
                  />
                  <span className="truncate">{o.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
