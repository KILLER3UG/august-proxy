/* ── WorkspaceToggle — green "Enabled" pill + adjacent Disable button ── */
/* Distinct from SettingsToggle: this renders a primary pill on the LEFT
 * showing the current state ("Enabled" in green when on), and an
 * action button on the RIGHT ("Disable" / "Enable"). Matches the
 * screenshot's provider editor header. */

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  /** Optional override for the label inside the pill. */
  enabledLabel?: string;
  disabledLabel?: string;
  /** Disable the toggle (e.g. while saving). */
  disabled?: boolean;
  className?: string;
}

export function WorkspaceToggle({
  enabled,
  onToggle,
  enabledLabel = 'Enabled',
  disabledLabel = 'Disabled',
  disabled,
  className,
}: Props) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span
        className={cn(
          'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium',
          enabled
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'bg-white/[0.06] text-muted-foreground',
        )}
      >
        {enabled ? enabledLabel : disabledLabel}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => onToggle(!enabled)}
      >
        {enabled ? 'Disable' : 'Enable'}
      </Button>
    </div>
  );
}
