/* ── Combined model + effort menu (Claude-like) ───────────────────────── */
/* One pill trigger; primary popover with Effort / More models flyouts.   */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import type { ModelItem } from '../model-display';
import {
  modelDisplayParts,
  formatContextWindow,
  getModelDisplayName,
} from '../model-display';
import type { EffortLevel } from '../hooks/useChatSend';

const EFFORT_OPTIONS: {
  value: EffortLevel;
  label: string;
  triggerLabel: string;
}[] = [
  { value: 'low', label: 'Low', triggerLabel: 'Low' },
  { value: 'medium', label: 'Medium (Default)', triggerLabel: 'Medium' },
  { value: 'high', label: 'High', triggerLabel: 'High' },
  { value: 'max', label: 'Max', triggerLabel: 'Max' },
];

type Flyout = 'effort' | 'models' | null;

const HOVER_OPEN_MS = 125;
const HOVER_CLOSE_MS = 175;

function shortModelName(model: ModelItem | null): string {
  if (!model) return 'Model';
  return modelDisplayParts(model.id || model.name || '').name || 'Model';
}

function ThinkingSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
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
  );
}

export function ModelEffortMenu({
  visibleModels,
  loading,
  selected,
  onSelect,
  onRefresh,
  onEditModels,
  effort,
  onEffortChange,
  thinkingEnabled,
  onThinkingChange,
}: {
  /** Full catalog (kept for call-site compatibility; flyout uses `visibleModels`). */
  models: ModelItem[];
  visibleModels: ModelItem[];
  loading?: boolean;
  selected: ModelItem | null;
  onSelect: (m: ModelItem) => void;
  onRefresh?: () => void;
  onEditModels?: () => void;
  effort: EffortLevel;
  onEffortChange: (v: EffortLevel) => void;
  thinkingEnabled: boolean;
  onThinkingChange: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [flyout, setFlyout] = useState<Flyout>(null);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverOpenTimer = useCallback(() => {
    if (hoverOpenTimer.current) {
      clearTimeout(hoverOpenTimer.current);
      hoverOpenTimer.current = null;
    }
  }, []);

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimer.current) {
      clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  }, []);

  const scheduleFlyoutOpen = useCallback(
    (next: Flyout) => {
      if (!next) return;
      clearHoverCloseTimer();
      if (flyout === next) return;
      clearHoverOpenTimer();
      hoverOpenTimer.current = setTimeout(() => setFlyout(next), HOVER_OPEN_MS);
    },
    [flyout, clearHoverCloseTimer, clearHoverOpenTimer],
  );

  const scheduleFlyoutClose = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    hoverCloseTimer.current = setTimeout(() => setFlyout(null), HOVER_CLOSE_MS);
  }, [clearHoverOpenTimer, clearHoverCloseTimer]);

  const keepFlyoutOpen = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
  }, [clearHoverOpenTimer, clearHoverCloseTimer]);

  const toggleFlyout = useCallback(
    (next: Flyout) => {
      clearHoverOpenTimer();
      clearHoverCloseTimer();
      setFlyout((f) => (f === next ? null : next));
    },
    [clearHoverOpenTimer, clearHoverCloseTimer],
  );
  const [primaryPos, setPrimaryPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [flyoutPos, setFlyoutPos] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const effortOpt =
    EFFORT_OPTIONS.find((o) => o.value === effort) || EFFORT_OPTIONS[1];

  const closeAll = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    setOpen(false);
    setFlyout(null);
    setSearchQuery('');
    setExpandedProviders(new Set());
  }, [clearHoverOpenTimer, clearHoverCloseTimer]);

  const computePrimaryPos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const width = 280;
    const estHeight = 220;
    const top = Math.max(8, r.top - estHeight - 6);
    let left = r.right - width;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    return { top, left, width };
  }, []);

  const refinePrimaryPos = useCallback(() => {
    const el = triggerRef.current;
    const panel = primaryRef.current;
    if (!el || !panel) return;
    const r = el.getBoundingClientRect();
    const width = 280;
    const panelHeight = panel.offsetHeight || 220;
    const top = Math.max(8, r.top - panelHeight - 6);
    let left = r.right - width;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    setPrimaryPos({ top, left, width });
  }, []);

  const computeFlyoutPos = useCallback(() => {
    const primary = primaryRef.current;
    if (!primary) return null;
    const r = primary.getBoundingClientRect();
    const flyoutW = flyout === 'models' ? 300 : 260;
    const gap = 6;
    let left = r.right + gap;
    if (left + flyoutW > window.innerWidth - 8) {
      left = r.left - flyoutW - gap;
    }
    left = Math.max(8, left);
    const top = Math.max(8, Math.min(r.top, window.innerHeight - 320));
    return { top, left };
  }, [flyout]);

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
    if (!open) {
      clearHoverOpenTimer();
      clearHoverCloseTimer();
    }
  }, [open, clearHoverOpenTimer, clearHoverCloseTimer]);

  useEffect(() => {
    return () => {
      clearHoverOpenTimer();
      clearHoverCloseTimer();
    };
  }, [clearHoverOpenTimer, clearHoverCloseTimer]);

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
      if (flyout === 'models') {
        setTimeout(() => searchRef.current?.focus(), 0);
      }
    });
  }, [open, flyout, computeFlyoutPos]);

  const filtered = searchQuery.trim()
    ? visibleModels.filter(
        (m) =>
          m.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
          getModelDisplayName(m.id).toLowerCase().includes(searchQuery.toLowerCase()) ||
          m.provider.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : visibleModels;

  const grouped = Object.entries(
    filtered.reduce(
      (acc, m) => {
        if (!acc[m.provider]) acc[m.provider] = [];
        acc[m.provider].push(m);
        return acc;
      },
      {} as Record<string, ModelItem[]>,
    ),
  ).map(([provider, list]) => {
    const sorted = [...list].sort((a, b) => {
      if (a.isFree && !b.isFree) return -1;
      if (!a.isFree && b.isFree) return 1;
      return getModelDisplayName(a.id).localeCompare(getModelDisplayName(b.id));
    });
    const isSearching = searchQuery.trim().length > 0;
    const isExpanded = expandedProviders.has(provider);
    const visible = isSearching || isExpanded ? sorted : sorted.slice(0, 5);
    const showCollapse = sorted.length > 5 && !isSearching;
    return {
      provider,
      models: sorted,
      visible,
      isExpanded,
      total: sorted.length,
      showCollapse,
    };
  });

  const panelMotion = {
    initial: { opacity: 0, y: 6, scale: 0.97 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 6, scale: 0.97 },
    transition: { duration: 0.15, ease: [0.16, 1, 0.3, 1] as const },
  };

  const primaryPanel = (
    <AnimatePresence>
      {open && primaryPos && (
        <motion.div
          ref={primaryRef}
          {...panelMotion}
          className="fixed z-50 bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden origin-bottom"
          style={{
            top: primaryPos.top,
            left: primaryPos.left,
            width: primaryPos.width,
          }}
        >
          <button
            type="button"
            className="w-full text-left px-3 py-2.5 flex items-start gap-2.5 hover:bg-muted/40 transition"
            onClick={() => setFlyout(null)}
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground truncate">
                {shortModelName(selected)}
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                {selected
                  ? `${selected.provider} · ${formatContextWindow(selected.contextWindow)}`
                  : 'Select a model'}
              </div>
            </div>
            {selected && <Check className="size-4 text-primary shrink-0 mt-0.5" />}
          </button>

          <div className="h-px bg-border/50 mx-2" />

          <button
            type="button"
            onClick={() => toggleFlyout('effort')}
            onMouseEnter={() => scheduleFlyoutOpen('effort')}
            onMouseLeave={scheduleFlyoutClose}
            className={cn(
              'w-full text-left px-3 py-2 flex items-center justify-between gap-2 hover:bg-muted/40 transition',
              flyout === 'effort' && 'bg-muted/30',
            )}
          >
            <span className="text-sm text-foreground">Effort</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {effortOpt.triggerLabel}
              <ChevronRight className="size-3.5 opacity-60" />
            </span>
          </button>

          <button
            type="button"
            onClick={() => toggleFlyout('models')}
            onMouseEnter={() => scheduleFlyoutOpen('models')}
            onMouseLeave={scheduleFlyoutClose}
            className={cn(
              'w-full text-left px-3 py-2 flex items-center justify-between gap-2 hover:bg-muted/40 transition',
              flyout === 'models' && 'bg-muted/30',
            )}
          >
            <span className="text-sm text-foreground">More models</span>
            <ChevronRight className="size-3.5 text-muted-foreground opacity-60" />
          </button>

          {(onEditModels || onRefresh) && (
            <>
              <div className="h-px bg-border/50 mx-2" />
              <div className="px-2 py-1.5 flex items-center gap-2">
                {onEditModels && (
                  <button
                    type="button"
                    onClick={() => {
                      onEditModels();
                      closeAll();
                    }}
                    className="text-[11px] text-muted-foreground hover:text-foreground transition px-1.5 py-1 rounded-md hover:bg-muted/40"
                  >
                    Edit models
                  </button>
                )}
                {onRefresh && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onRefresh();
                    }}
                    disabled={loading}
                    className={cn(
                      'ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition',
                      loading && 'animate-spin',
                    )}
                    title="Refresh models"
                  >
                    <RefreshCw className="size-3" />
                  </button>
                )}
              </div>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );

  const effortFlyout = (
    <AnimatePresence>
      {open && flyout === 'effort' && flyoutPos && (
        <motion.div
          ref={flyoutRef}
          {...panelMotion}
          onMouseEnter={keepFlyoutOpen}
          onMouseLeave={scheduleFlyoutClose}
          className="fixed z-50 w-[260px] bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden origin-left"
          style={{ top: flyoutPos.top, left: flyoutPos.left }}
        >
          <div className="px-3 pt-2.5 pb-1.5 text-[11px] leading-snug text-muted-foreground">
            Higher effort means more thorough responses. Takes longer and uses
            more tokens.
          </div>
          <div className="py-0.5">
            {EFFORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onEffortChange(opt.value);
                  setFlyout(null);
                }}
                className={cn(
                  'w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 transition',
                  effort === opt.value
                    ? 'text-primary bg-primary/10 font-medium'
                    : 'text-foreground/85 hover:bg-muted/40',
                )}
              >
                <span>{opt.label}</span>
                {effort === opt.value && <Check className="size-3.5 shrink-0" />}
              </button>
            ))}
          </div>
          <div className="h-px bg-border/50 mx-2" />
          <div className="px-3 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">Thinking</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {thinkingEnabled
                  ? 'Show extended reasoning for this turn'
                  : 'Answer directly without extended reasoning'}
              </div>
            </div>
            <ThinkingSwitch
              checked={thinkingEnabled}
              onChange={onThinkingChange}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  const modelsFlyout = (
    <AnimatePresence>
      {open && flyout === 'models' && flyoutPos && (
        <motion.div
          ref={flyoutRef}
          {...panelMotion}
          onMouseEnter={keepFlyoutOpen}
          onMouseLeave={scheduleFlyoutClose}
          className="fixed z-50 w-[300px] bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden origin-left"
          style={{ top: flyoutPos.top, left: flyoutPos.left }}
        >
          <div className="px-2 pt-2 pb-1">
            <div className="flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1">
              <svg
                className="size-2.5 shrink-0 text-muted-foreground"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search…"
                className="bg-transparent text-sm outline-none w-full placeholder:text-muted-foreground/50 text-foreground py-0.5"
              />
            </div>
          </div>
          <div
            ref={listRef}
            className="max-h-[260px] overflow-y-auto py-0.5"
          >
            {loading && grouped.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                Loading models…
              </div>
            ) : grouped.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                {searchQuery.trim()
                  ? `No results for "${searchQuery.trim()}"`
                  : 'No models loaded'}
              </div>
            ) : (
              grouped.map(({ provider, visible, isExpanded, total, showCollapse }) => (
                <div key={provider}>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold sticky top-0 bg-popover/95 backdrop-blur">
                    {provider}
                  </div>
                  {visible.map((m) => {
                    const { name, tag } = modelDisplayParts(m.id);
                    const isSelected = selected?.id === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          onSelect(m);
                          closeAll();
                        }}
                        className={cn(
                          'w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition',
                          isSelected
                            ? 'text-primary bg-primary/10 font-medium'
                            : 'text-foreground/85 hover:bg-muted/40',
                        )}
                      >
                        <span className="truncate flex-1">
                          {name}
                          {tag && (
                            <span className="ml-1.5 text-[10px] text-muted-foreground/50 font-normal">
                              {tag}
                            </span>
                          )}
                        </span>
                        {isSelected && <Check className="size-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                  {showCollapse && (
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedProviders((prev) => {
                          const next = new Set(prev);
                          if (isExpanded) next.delete(provider);
                          else next.add(provider);
                          return next;
                        });
                      }}
                      className="w-full text-left px-3 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/30 transition"
                    >
                      {isExpanded
                        ? 'Show less'
                        : `Show ${total - 5} more`}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) closeAll();
          else setOpen(true);
        }}
        className={cn(
          'relative flex items-center gap-1 text-xs outline-none cursor-pointer shrink-0 h-8',
          'text-muted-foreground hover:text-foreground transition-all duration-200',
          'bg-muted/40 hover:bg-muted/60 rounded-full px-2.5 py-1',
        )}
        title={
          selected
            ? `${getModelDisplayName(selected.id || selected.name || '')} · ${effortOpt.triggerLabel}`
            : 'Select model'
        }
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="truncate max-w-[160px] font-medium text-foreground">
          {shortModelName(selected)}
        </span>
        <span className="text-muted-foreground shrink-0">
          {effortOpt.triggerLabel}
        </span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 opacity-60 transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>
      {typeof document !== 'undefined' &&
        createPortal(
          <>
            {primaryPanel}
            {effortFlyout}
            {modelsFlyout}
          </>,
          document.body,
        )}
    </>
  );
}
