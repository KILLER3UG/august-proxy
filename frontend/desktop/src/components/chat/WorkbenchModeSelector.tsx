import { useState } from 'react';
import { FileCheck, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type WorkbenchGuardMode = 'plan' | 'full' | 'ask';

export interface WorkbenchGuardModeConfig {
  id: WorkbenchGuardMode;
  label: string;
  description: string;
  agentId: 'plan' | 'build';
  prefix: string;
  icon: LucideIcon;
}

export const WORKBENCH_GUARD_MODES = {
  plan: {
    id: 'plan',
    label: 'Plan mode',
    description: 'Plan before editing',
    agentId: 'plan' as const,
    prefix: 'Create a plan first and wait for my approval before editing or changing anything: ',
    icon: FileCheck,
  },
  full: {
    id: 'full',
    label: 'Full access',
    description: 'Fewer confirmations where allowed',
    agentId: 'build' as const,
    prefix: 'Run this with fewer confirmations where allowed. Still respect backend approval gates: ',
    icon: Zap,
  },
  ask: {
    id: 'ask',
    label: 'Ask before changes',
    description: 'Ask before file changes',
    agentId: 'build' as const,
    prefix: 'Before making any file changes or mutations, ask me for confirmation first: ',
    icon: ShieldCheck,
  },
} as const satisfies Record<WorkbenchGuardMode, WorkbenchGuardModeConfig>;

export function getWorkbenchGuardMode(mode: WorkbenchGuardMode) {
  return WORKBENCH_GUARD_MODES[mode];
}

export function applyWorkbenchGuardMode(mode: WorkbenchGuardMode, message: string) {
  const guard = getWorkbenchGuardMode(mode);
  const trimmed = message.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('/')) return trimmed;
  return `${guard.prefix}${trimmed}`;
}

interface WorkbenchModeSelectorProps {
  selectedMode: WorkbenchGuardMode;
  onChange: (mode: WorkbenchGuardMode) => void;
  className?: string;
}

export function WorkbenchModeSelector({ selectedMode, onChange, className }: WorkbenchModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const guard = getWorkbenchGuardMode(selectedMode);
  const options = Object.values(WORKBENCH_GUARD_MODES) as WorkbenchGuardModeConfig[];

  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="px-2 py-1 rounded-md text-[11px] bg-muted hover:bg-muted/70 text-foreground border border-border/50 capitalize"
        title={guard.description}
      >
        {guard.label}
      </button>

      {open && (
        <div className="absolute right-0 bottom-full mb-2 w-56 bg-card border border-border rounded-xl shadow-2xl p-1.5 z-20">
          {options.map((option) => {
            const OptionIcon = option.icon;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                className={cn(
                  'w-full text-left px-2 py-1.5 rounded-md hover:bg-muted transition',
                  selectedMode === option.id && 'bg-primary/10 text-primary'
                )}
                title={option.description}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium">{option.label}</span>
                  <OptionIcon className="size-3.5 text-muted-foreground" />
                </div>
                <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                  {option.description}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
