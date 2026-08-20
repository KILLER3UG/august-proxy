/* ── ToolBtn ─ small icon button for the composer toolbar ────────────── */
/* The rest of the legacy ComposerControls (ModelDropdown, EffortDropdown) */
/* was removed after Phase 4 — the current pickers live in                */
/* ModelEffortMenu / WorkbenchModeSelector.                               */

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ToolBtn({ Icon, label, onClick, className, buttonRef }: { Icon: LucideIcon; label: string; onClick?: () => void; className?: string; buttonRef?: React.RefObject<HTMLButtonElement | null> }) {
  return (
    <button
      ref={buttonRef ?? undefined}
      onClick={onClick}
      className={cn('h-8 w-8 p-0 rounded-lg hover:bg-muted hover:text-foreground transition text-muted-foreground', className)}
      title={label}
      aria-label={label}
    >
      <Icon className="size-3.5" />
    </button>
  );
}
