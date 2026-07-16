/* eslint-disable react-refresh/only-export-components */
/* Codex-like sandbox chip — orthogonal to Plan/Ask/Full guard modes. */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Shield } from 'lucide-react';
import { cn } from '@/lib/utils';

export type WorkbenchSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface WorkbenchSandboxModeConfig {
  id: WorkbenchSandboxMode;
  label: string;
  shortLabel: string;
  description: string;
}

export const WORKBENCH_SANDBOX_MODES = {
  'read-only': {
    id: 'read-only',
    label: 'Project read-only',
    shortLabel: 'Read-only',
    description:
      'Tool reach: inspect the project only — no writes, no network. (Agent mode still controls approvals.)',
  },
  'workspace-write': {
    id: 'workspace-write',
    label: 'Project only',
    shortLabel: 'Project',
    description:
      'Tool reach (default): edit/run inside this project; block home folder + network. Not an approval mode.',
  },
  'danger-full-access': {
    id: 'danger-full-access',
    label: 'Whole machine',
    shortLabel: 'Machine',
    description:
      'Tool reach: shell can touch the whole machine and network. Prefer agent mode “Ask” if you use this.',
  },
} as const satisfies Record<WorkbenchSandboxMode, WorkbenchSandboxModeConfig>;

export function getWorkbenchSandboxMode(mode: WorkbenchSandboxMode) {
  return WORKBENCH_SANDBOX_MODES[mode] ?? WORKBENCH_SANDBOX_MODES['workspace-write'];
}

export function normalizeSandboxMode(raw: string | null | undefined): WorkbenchSandboxMode {
  const v = (raw || '').trim().toLowerCase().replace(/_/g, '-');
  if (v === 'read-only' || v === 'readonly' || v === 'read') return 'read-only';
  if (v === 'danger-full-access' || v === 'full' || v === 'danger') return 'danger-full-access';
  return 'workspace-write';
}

interface SandboxModeSelectorProps {
  selectedMode: WorkbenchSandboxMode;
  onChange: (mode: WorkbenchSandboxMode) => void;
  className?: string;
}

export function SandboxModeSelector({ selectedMode, onChange, className }: SandboxModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const current = getWorkbenchSandboxMode(selectedMode);
  const options = Object.values(WORKBENCH_SANDBOX_MODES) as WorkbenchSandboxModeConfig[];
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const compute = () => {
      const el = triggerRef.current;
      const panel = panelRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const panelHeight = panel?.offsetHeight || 180;
      setPos({
        top: Math.max(8, r.top - panelHeight - 6),
        right: Math.max(8, window.innerWidth - r.right),
      });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'h-7 px-2 rounded-full text-[11px] font-medium inline-flex items-center gap-1 transition',
          'border border-border/50 bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted/70',
          className,
        )}
        title={current.description}
        data-testid="sandbox-mode-chip"
        aria-label={`Sandbox: ${current.label}`}
      >
        <Shield className="size-3 opacity-80" />
        {current.shortLabel}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[80] w-72 rounded-xl border border-border/60 bg-popover p-1.5 shadow-xl"
            style={{ top: pos.top, right: pos.right }}
            data-testid="sandbox-mode-menu"
          >
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Sandbox
            </div>
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                className={cn(
                  'w-full text-left px-2 py-1.5 rounded-md text-xs transition',
                  selectedMode === option.id
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-muted text-foreground',
                )}
              >
                <div className="font-medium">{option.label}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                  {option.description}
                </div>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export default SandboxModeSelector;
