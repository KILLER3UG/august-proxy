/* ── WorkspaceNavLink — left-rail nav item matching the screenshot ──── */
/* Active state uses a subtle background + accent text. Inactive items
 * stay muted with a hover state. Matches the style from your screenshots. */

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onSelect: () => void;
}

export function WorkspaceNavLink({ icon: Icon, label, active, onSelect }: Props) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full flex items-center gap-2.5 px-4 py-2 text-sm transition text-left',
        active
          ? 'bg-white/[0.06] text-foreground font-medium'
          : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground',
      )}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
      <span className="truncate">{label}</span>
    </button>
  );
}
