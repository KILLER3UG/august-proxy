/* eslint-disable react-refresh/only-export-components */

/* ── WorkbenchModeSelector — agent mode + tool reach (model-menu style) ─ */
/* One pill trigger. Primary popover has two hover flyouts:
 *   Agent mode → Plan / Ask / Make changes
 *   Tool reach → Read-only / Project / Whole machine
 * Portaled + fixed so the chat column overflow does not clip panels. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  chipTrigger,
  menuFlyout,
  menuFlyoutSwap,
  menuItem,
  menuItemHover,
  menuItemStagger,
  menuPanel,
} from '@/lib/motion';
import { useFlyoutHover } from '@/hooks/useFlyoutHover';
import {
  WORKBENCH_SANDBOX_MODES,
  getWorkbenchSandboxMode,
  type WorkbenchSandboxMode,
  type WorkbenchSandboxModeConfig,
} from '@/components/chat/SandboxModeSelector';

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

type FlyoutKind = 'agent' | 'reach';

interface WorkbenchModeSelectorProps {
  selectedMode: WorkbenchGuardMode;
  onChange: (mode: WorkbenchGuardMode) => void;
  sandboxMode: WorkbenchSandboxMode;
  onSandboxChange: (mode: WorkbenchSandboxMode) => void;
  className?: string;
}

export function WorkbenchModeSelector({
  selectedMode,
  onChange,
  sandboxMode,
  onSandboxChange,
  className,
}: WorkbenchModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const {
    flyout,
    setFlyout,
    scheduleFlyoutOpen,
    scheduleFlyoutClose,
    keepFlyoutOpen,
    toggleFlyout,
    resetFlyout,
    clearAllTimers,
  } = useFlyoutHover<FlyoutKind>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);

  const guard = getWorkbenchGuardMode(selectedMode);
  const sandbox = getWorkbenchSandboxMode(sandboxMode);
  const agentOptions = Object.values(WORKBENCH_GUARD_MODES) as WorkbenchGuardModeConfig[];
  const reachOptions = Object.values(WORKBENCH_SANDBOX_MODES) as WorkbenchSandboxModeConfig[];

  const [primaryPos, setPrimaryPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [flyoutPos, setFlyoutPos] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const closeAll = useCallback(() => {
    clearAllTimers();
    setOpen(false);
    resetFlyout();
  }, [clearAllTimers, resetFlyout]);

  const computePrimaryPos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const width = 280;
    const estHeight = 140;
    const top = Math.max(8, r.top - estHeight - 6);
    let left = r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    return { top, left, width };
  }, []);

  const refinePrimaryPos = useCallback(() => {
    const el = triggerRef.current;
    const panel = primaryRef.current;
    if (!el || !panel) return;
    const r = el.getBoundingClientRect();
    const width = 280;
    const panelHeight = panel.offsetHeight || 140;
    const top = Math.max(8, r.top - panelHeight - 6);
    let left = r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    setPrimaryPos({ top, left, width });
  }, []);

  const computeFlyoutPos = useCallback(() => {
    const primary = primaryRef.current;
    if (!primary) return null;
    const r = primary.getBoundingClientRect();
    const flyoutW = 280;
    const gap = 6;
    let left = r.right + gap;
    if (left + flyoutW > window.innerWidth - 8) {
      left = r.left - flyoutW - gap;
    }
    left = Math.max(8, left);
    const top = Math.max(8, Math.min(r.top, window.innerHeight - 280));
    return { top, left };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (primaryRef.current?.contains(target)) return;
      if (flyoutRef.current?.contains(target)) return;
      closeAll();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, closeAll]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (flyout) setFlyout(null);
        else closeAll();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, flyout, closeAll]);

  useEffect(() => {
    if (!open) resetFlyout();
  }, [open, resetFlyout]);

  useEffect(() => {
    if (!open) {
      setPrimaryPos(null);
      setFlyoutPos(null);
      return;
    }
    const initial = computePrimaryPos();
    if (initial) setPrimaryPos(initial);
    requestAnimationFrame(() => refinePrimaryPos());
    const onScroll = () => {
      refinePrimaryPos();
      if (flyout) {
        const fp = computeFlyoutPos();
        if (fp) setFlyoutPos(fp);
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, flyout, computePrimaryPos, refinePrimaryPos, computeFlyoutPos]);

  useEffect(() => {
    if (!open || !flyout) {
      setFlyoutPos(null);
      return;
    }
    requestAnimationFrame(() => {
      const fp = computeFlyoutPos();
      if (fp) setFlyoutPos(fp);
    });
  }, [open, flyout, computeFlyoutPos]);

  const primaryPanel = (
    <AnimatePresence>
      {open && primaryPos && (
        <motion.div
          ref={primaryRef}
          {...menuPanel}
          className="fixed z-50 bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden origin-bottom"
          style={{
            top: primaryPos.top,
            left: primaryPos.left,
            width: primaryPos.width,
          }}
          data-testid="agent-mode-menu"
        >
          <motion.div
            variants={menuItemStagger}
            initial="initial"
            animate="animate"
          >
            <motion.div variants={menuItem} className="px-3 pt-2.5 pb-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80 font-semibold">
                Permissions
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground mt-0.5">
                Agent mode is approvals. Tool reach is where shell/files can go.
              </p>
            </motion.div>

            <div className="h-px bg-border/50 mx-2" />

            <motion.button
              type="button"
              variants={menuItem}
              {...menuItemHover}
              onClick={() => toggleFlyout('agent')}
              onMouseEnter={() => scheduleFlyoutOpen('agent')}
              onMouseLeave={scheduleFlyoutClose}
              className={cn(
                'w-full text-left px-3 py-2 flex items-center justify-between gap-2 hover:bg-muted/40 transition',
                flyout === 'agent' && 'bg-muted/30',
              )}
              data-testid="agent-mode-row"
            >
              <span className="text-sm text-foreground">Agent mode</span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {guard.label}
                <ChevronRight className="size-3.5 opacity-60" />
              </span>
            </motion.button>

            <motion.button
              type="button"
              variants={menuItem}
              {...menuItemHover}
              onClick={() => toggleFlyout('reach')}
              onMouseEnter={() => scheduleFlyoutOpen('reach')}
              onMouseLeave={scheduleFlyoutClose}
              className={cn(
                'w-full text-left px-3 py-2 flex items-center justify-between gap-2 hover:bg-muted/40 transition',
                flyout === 'reach' && 'bg-muted/30',
              )}
              data-testid="tool-reach-row"
            >
              <span className="text-sm text-foreground">Tool reach</span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {sandbox.shortLabel}
                <ChevronRight className="size-3.5 opacity-60" />
              </span>
            </motion.button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  const sideFlyout = (
    <AnimatePresence>
      {open && flyout && flyoutPos && (
        <motion.div
          ref={flyoutRef}
          {...menuFlyout}
          onMouseEnter={keepFlyoutOpen}
          onMouseLeave={scheduleFlyoutClose}
          className="fixed z-50 w-[280px] bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden origin-left"
          style={{ top: flyoutPos.top, left: flyoutPos.left }}
          data-testid={
            flyout === 'agent' ? 'agent-mode-flyout' : 'tool-reach-flyout'
          }
        >
          <AnimatePresence initial={false} mode="wait">
              {flyout === 'agent' ? (
                <motion.div key="agent" {...menuFlyoutSwap}>
                  <div className="px-3 pt-2.5 pb-1.5 text-[11px] leading-snug text-muted-foreground">
                    Should August act? Approvals only — not the same as tool
                    reach.
                  </div>
                  <div className="py-0.5 pb-1">
                    {agentOptions.map((option) => (
                      <motion.button
                        key={option.id}
                        type="button"
                        {...menuItemHover}
                        onClick={() => {
                          onChange(option.id);
                          setFlyout(null);
                        }}
                        className={cn(
                          'w-full text-left px-3 py-2 transition',
                          selectedMode === option.id
                            ? 'text-primary bg-primary/10'
                            : 'text-foreground/85 hover:bg-muted/40',
                        )}
                        title={option.description}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">
                            {option.label}
                          </span>
                          {selectedMode === option.id && (
                            <Check className="size-3.5 shrink-0" />
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                          {option.description}
                        </p>
                      </motion.button>
                    ))}
                  </div>
                </motion.div>
              ) : (
                <motion.div key="reach" {...menuFlyoutSwap}>
                  <div className="px-3 pt-2.5 pb-1.5 text-[11px] leading-snug text-muted-foreground">
                    Where shell/files can go. Project only by default.
                  </div>
                  <div className="py-0.5 pb-1">
                    {reachOptions.map((option) => (
                      <motion.button
                        key={option.id}
                        type="button"
                        {...menuItemHover}
                        onClick={() => {
                          onSandboxChange(option.id);
                          setFlyout(null);
                        }}
                        className={cn(
                          'w-full text-left px-3 py-2 transition',
                          sandboxMode === option.id
                            ? 'text-primary bg-primary/10'
                            : 'text-foreground/85 hover:bg-muted/40',
                        )}
                        title={option.description}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">
                            {option.label}
                          </span>
                          {sandboxMode === option.id && (
                            <Check className="size-3.5 shrink-0" />
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                          {option.description}
                        </p>
                      </motion.button>
                    ))}
                  </div>
                </motion.div>
              )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className={cn('relative', className)}>
      <motion.button
        ref={triggerRef}
        type="button"
        {...chipTrigger}
        onClick={() => {
          if (open) closeAll();
          else {
            resetFlyout();
            setOpen(true);
          }
        }}
        className="h-8 px-2.5 py-1 rounded-full text-[11px] font-medium bg-muted hover:bg-muted/70 text-foreground border border-border/50 inline-flex items-center gap-1 max-w-[200px]"
        title={`${guard.description}\nTool reach: ${sandbox.description}`}
        aria-label={`Agent mode: ${guard.label}. Tool reach: ${sandbox.shortLabel}`}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="agent-mode-chip"
      >
        <span className="truncate">{guard.label}</span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 opacity-60 transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </motion.button>
      {typeof document !== 'undefined' &&
        createPortal(
          <>
            {primaryPanel}
            {sideFlyout}
          </>,
          document.body,
        )}
    </div>
  );
}
