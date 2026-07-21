/* eslint-disable react-refresh/only-export-components */

/* ── WorkbenchModeSelector — agent mode popover + tool-reach flyout ──── */
/* Matches model dropdown: compact primary panel, Tool reach as a side
 * flyout (not stacked in the same tall list). */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Hand,
  Shield,
  ShieldCheck,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  chipTrigger,
  menuFlyout,
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

export type WorkbenchGuardMode = 'ask' | 'edit' | 'plan' | 'full';

export interface WorkbenchGuardModeConfig {
  id: WorkbenchGuardMode;
  label: string;
  description: string;
  agentId: 'plan' | 'build';
  Icon: typeof Hand;
}

/** Display order matches the reference: Ask → Edit → Plan → Full. */
export const WORKBENCH_GUARD_MODES = {
  ask: {
    id: 'ask',
    label: 'Ask before changes',
    description: 'Ask before file changes.',
    agentId: 'build' as const,
    Icon: Hand,
  },
  edit: {
    id: 'edit',
    label: 'Edit automatically',
    description: 'Edit files automatically.',
    agentId: 'build' as const,
    Icon: ShieldCheck,
  },
  plan: {
    id: 'plan',
    label: 'Plan mode',
    description: 'Plan before editing.',
    agentId: 'plan' as const,
    Icon: ClipboardList,
  },
  full: {
    id: 'full',
    label: 'Full access',
    description: 'Run with fewer confirmations.',
    agentId: 'build' as const,
    Icon: Shield,
  },
} as const satisfies Record<WorkbenchGuardMode, WorkbenchGuardModeConfig>;

export const WORKBENCH_GUARD_MODE_ORDER: WorkbenchGuardMode[] = [
  'ask',
  'edit',
  'plan',
  'full',
];

export function getWorkbenchGuardMode(mode: WorkbenchGuardMode) {
  return WORKBENCH_GUARD_MODES[mode] ?? WORKBENCH_GUARD_MODES.full;
}

export function applyWorkbenchGuardMode(_mode: WorkbenchGuardMode, message: string) {
  return message.trim();
}

type FlyoutKind = 'reach';

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
  const agentOptions = WORKBENCH_GUARD_MODE_ORDER.map((id) => WORKBENCH_GUARD_MODES[id]);
  const reachOptions = Object.values(WORKBENCH_SANDBOX_MODES) as WorkbenchSandboxModeConfig[];

  const [primaryPos, setPrimaryPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number } | null>(null);

  const closeAll = useCallback(() => {
    clearAllTimers();
    setOpen(false);
    resetFlyout();
  }, [clearAllTimers, resetFlyout]);

  const computePrimaryPos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return null;
    const width = 280;
    const estHeight = 260;
    const r = el.getBoundingClientRect();
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
    const panelHeight = panel.offsetHeight || 260;
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
  }, [open, flyout, closeAll, setFlyout]);

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

  useLayoutEffect(() => {
    if (!open || !flyout) {
      if (!flyout) setFlyoutPos(null);
      return;
    }
    const seeded = computeFlyoutPos();
    if (seeded) setFlyoutPos(seeded);
    const raf = requestAnimationFrame(() => {
      const fp = computeFlyoutPos();
      if (fp) setFlyoutPos(fp);
    });
    return () => cancelAnimationFrame(raf);
  }, [open, flyout, computeFlyoutPos]);

  const ModeIcon = guard.Icon;

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
          role="menu"
          aria-label="Agent mode"
        >
          <motion.div variants={menuItemStagger} initial="initial" animate="animate" className="py-1">
            {agentOptions.map((option) => {
              const Icon = option.Icon;
              const selected = selectedMode === option.id;
              return (
                <motion.button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  variants={menuItem}
                  {...menuItemHover}
                  onClick={() => {
                    onChange(option.id);
                    closeAll();
                  }}
                  className={cn(
                    'w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition',
                    selected ? 'bg-muted/40' : 'hover:bg-muted/30',
                  )}
                  data-testid="agent-mode-row"
                  data-mode={option.id}
                >
                  <Icon
                    className={cn(
                      'size-4 mt-0.5 shrink-0',
                      selected ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground leading-snug">
                      {option.label}
                    </span>
                    <span className="block mt-0.5 text-[11px] leading-snug text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                  {selected ? (
                    <Check className="size-4 shrink-0 mt-0.5 text-foreground" aria-hidden />
                  ) : (
                    <span className="size-4 shrink-0" aria-hidden />
                  )}
                </motion.button>
              );
            })}

            <div className="h-px bg-border/50 mx-2 my-1" />

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
      {open && flyout === 'reach' && flyoutPos && (
        <motion.div
          ref={flyoutRef}
          {...menuFlyout}
          onMouseEnter={keepFlyoutOpen}
          onMouseLeave={scheduleFlyoutClose}
          className="fixed z-50 w-[280px] bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden origin-left"
          style={{ top: flyoutPos.top, left: flyoutPos.left }}
          data-testid="tool-reach-flyout"
          role="menu"
          aria-label="Tool reach"
        >
          <div className="px-3 pt-2.5 pb-1.5 text-[11px] leading-snug text-muted-foreground">
            Where shell/files can go. Separate from agent mode approvals.
          </div>
          <div className="py-0.5 pb-1">
            {reachOptions.map((option) => {
              const selected = sandboxMode === option.id;
              return (
                <motion.button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  {...menuItemHover}
                  onClick={() => {
                    onSandboxChange(option.id);
                    setFlyout(null);
                  }}
                  className={cn(
                    'w-full text-left px-3 py-2 transition',
                    selected
                      ? 'text-primary bg-primary/10'
                      : 'text-foreground/85 hover:bg-muted/40',
                  )}
                  title={option.description}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{option.label}</span>
                    {selected && <Check className="size-3.5 shrink-0" />}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {option.description}
                  </p>
                </motion.button>
              );
            })}
          </div>
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
        className="h-8 px-2.5 py-1 rounded-full text-[11px] font-medium bg-muted hover:bg-muted/70 text-foreground border border-border/50 inline-flex items-center gap-1.5 max-w-[220px]"
        title={`${guard.description}\nTool reach: ${sandbox.description}`}
        aria-label={`Agent mode: ${guard.label}. Tool reach: ${sandbox.shortLabel}`}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="agent-mode-chip"
      >
        <ModeIcon className="size-3.5 shrink-0 opacity-80" aria-hidden />
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
