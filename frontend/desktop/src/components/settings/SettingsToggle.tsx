/* ── SettingsToggle — accessible iOS-style switch ──────────────────── */
/* Real <button> with role="switch" + aria-checked. Works with keyboard
 * (Space/Enter) and screen readers. Optional label/description/tooltip row
 * so it drops straight into a card list. */

import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SettingsTooltip } from './SettingsTooltip';

interface SettingsToggleProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Beginner-friendly explanation shown via a ? icon next to the label. */
  tooltip?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

export function SettingsToggle({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  tooltip,
  className,
  'data-testid': testId,
}: SettingsToggleProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition',
        disabled ? 'opacity-60' : 'hover:bg-muted/40',
        className,
      )}
      data-testid={testId ? `${testId}-row` : undefined}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {tooltip && <SettingsTooltip content={tooltip} />}
        </div>
        {description && (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        data-testid={testId}
        onClick={() => !disabled && onCheckedChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed',
          checked ? 'bg-primary' : 'bg-muted-foreground/25',
        )}
      >
        <span
          className={cn(
            'inline-block size-4 transform rounded-full bg-white shadow transition',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}
