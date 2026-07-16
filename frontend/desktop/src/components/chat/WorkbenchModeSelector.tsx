/* eslint-disable react-refresh/only-export-components */

/* ── WorkbenchModeSelector — chat-side permission pill dropdown ────── */
/* The dropdown opens upward from the "Full access" / "Plan mode" /
 * "Ask before changes" pill next to the chat input. It was rendered as
 * `absolute bottom-full ... z-20` inside the composer, but the chat
 * thread column has `overflow: hidden`, so the popup got clipped at the
 * chat-thread boundary whenever there wasn't enough room above the trigger.
 *
 * The dropdown panel is now portaled to `document.body` with
 * `position: fixed` so it escapes the overflow chain entirely. The trigger
 * button stays inline. */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export type WorkbenchGuardMode = 'plan' | 'full' | 'ask';

export interface WorkbenchGuardModeConfig {
  id: WorkbenchGuardMode;
  label: string;
  description: string;
  agentId: 'plan' | 'build';
}

export const WORKBENCH_GUARD_MODES = {
  plan: {
    id: 'plan',
    label: 'Plan only',
    description:
      'Agent mode: don’t change files yet — August investigates, then shows a plan for you to approve.',
    agentId: 'plan' as const,
  },
  ask: {
    id: 'ask',
    label: 'Ask before changes',
    description:
      'Agent mode: August asks you before changing files or running risky commands. (Separate from tool reach / sandbox.)',
    agentId: 'build' as const,
  },
  full: {
    id: 'full',
    label: 'Make changes',
    description:
      'Agent mode: August can edit and run tools without asking each time. You can still Stop anytime.',
    agentId: 'build' as const,
  },
} as const satisfies Record<WorkbenchGuardMode, WorkbenchGuardModeConfig>;

export function getWorkbenchGuardMode(mode: WorkbenchGuardMode) {
  return WORKBENCH_GUARD_MODES[mode];
}

export function applyWorkbenchGuardMode(_mode: WorkbenchGuardMode, message: string) {
  return message.trim();
}

interface WorkbenchModeSelectorProps {
  selectedMode: WorkbenchGuardMode;
  onChange: (mode: WorkbenchGuardMode) => void;
  className?: string;
}

export function WorkbenchModeSelector({ selectedMode, onChange, className }: WorkbenchModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const guard = getWorkbenchGuardMode(selectedMode);
  const options = Object.values(WORKBENCH_GUARD_MODES) as WorkbenchGuardModeConfig[];

  // Position in viewport coordinates for the portaled panel. Computed from
  // the trigger's rect whenever the dropdown opens or the page scrolls /
  // resizes while it's open.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const compute = () => {
      const el = triggerRef.current;
      const panel = panelRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const panelHeight = panel?.offsetHeight || 200;
      const panelWidth = panel?.offsetWidth || 256;
      const top = Math.max(8, r.top - panelHeight - 4);
      // Prefer aligning to the trigger’s left so the menu stays near the chip
      // when it sits on the left side of the composer.
      let left = r.left;
      if (left + panelWidth > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - panelWidth - 8);
      }
      setPos({ top, left });
    };
    requestAnimationFrame(compute);
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open]);

  // Outside click + Escape close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const panelContent = open && pos && (
    <div
      ref={panelRef}
      className="fixed z-50 w-64 bg-card border border-border rounded-xl shadow-2xl p-1.5 animate-in fade-in slide-in-from-bottom-2 duration-150"
      style={{ top: pos.top, left: pos.left }}
      role="listbox"
      data-testid="agent-mode-menu"
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/80 font-semibold">
        Agent mode
      </div>
      <p className="px-2 pb-1.5 text-[10px] leading-snug text-muted-foreground">
        Should August act? Approvals only — not the same as tool reach (sandbox).
      </p>
      {options.map((option) => (
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
          <span className="text-xs font-medium">{option.label}</span>
          <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
            {option.description}
          </p>
        </button>
      ))}
    </div>
  );

  return (
    <div className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="h-8 px-2.5 py-1 rounded-full text-[11px] font-medium bg-muted hover:bg-muted/70 text-foreground border border-border/50"
        title={guard.description}
        aria-label={`Agent mode: ${guard.label}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-testid="agent-mode-chip"
      >
        {guard.label}
      </button>
      {typeof document !== 'undefined' && createPortal(panelContent, document.body)}
    </div>
  );
}
