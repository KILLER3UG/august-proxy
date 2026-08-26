/* ── Combined model + effort menu ─────────────────────────────────────── */
/* OpenCode-style picker matching the reference screenshot: the model chip */
/* opens a narrow PROVIDER LIST ("Manage models" pinned at the bottom) and */
/* hovering a provider slides a SEPARATE flyout card beside the panel with */
/* that provider's models — plain rows, pin on hover, check on selected.  */
/* The effort chip opens a small pane with a vertical effort list (✓ on   */
/* the active row) + thinking toggle. No search, no filters — the calm    */
/* three-part layout.                                                     */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, Gauge, Pin } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { chipTrigger, menuPanel, menuItem } from '@/lib/motion';
import { providersApi } from '@/api/providers';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import type { ModelItem } from '../model-display';
import { compareModelsRanked } from '../model-display';
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

/** Chip label: `Provider/model-id`, matching the reference composer. */
export function chipModelLabel(model: ModelItem | null): string {
  if (!model) return 'Model';
  const raw = `${model.provider}/${model.id || model.name || ''}`;
  return raw.length > 34 ? `${raw.slice(0, 32)}…` : raw;
}

type PaneKind = 'models' | 'effort';

type AnchorPos = { top: number; left: number };

/** Composer-anchored panels: positioned by their BOTTOM edge (CSS bottom +
 *  clamped maxHeight) so short lists hug the chip instead of floating far
 *  above it. */
type PanelPos = { left: number; bottom: number; maxHeight: number };

const MODELS_PANEL_W = 188;
/** Ideal heights — panels render shorter than these when room is tight. */
const MODELS_PANEL_H = 380;
const EFFORT_PANEL_H = 150;
const FLYOUT_W = 216;
const FLYOUT_H = 320;
const EFFORT_PANEL_W = 264;

/** Gap between the panel's bottom edge and the trigger chip. */
const PANEL_GAP = 8;
/** Viewport margin kept clear above/below a panel. */
const VIEWPORT_MARGIN = 8;
/** Never shrink below this — the list scrolls internally instead. */
const MIN_PANEL_H = 96;

function clampLeft(left: number, w: number): number {
  return Math.max(8, Math.min(left, window.innerWidth - w - 8));
}

/** Side flyouts anchor by top edge (they sit BESIDE the panel, not above
 *  the chip), clamped to the viewport. */
function clampTop(top: number, h: number): number {
  return Math.max(8, Math.min(top, window.innerHeight - h - 8));
}

/**
 * Bottom-edge anchoring (Zed/Cursor style): the panel's bottom edge sits
 * PANEL_GAP above the chip's top and the panel grows upward only as far
 * as the viewport allows. Returns a CSS `bottom` plus a clamped
 * `maxHeight`, so the visible height follows the CONTENT (short provider
 * lists stay next to the composer) instead of reserving the full ideal
 * height deep inside the transcript.
 */
function anchorAbove(chipTop: number, idealH: number): { bottom: number; maxHeight: number } {
  const wantedBottomEdge = chipTop - PANEL_GAP;
  // Clamp the bottom edge into the viewport; the lower bound keeps at least
  // MIN_PANEL_H usable above the margin even when the chip sits near the top.
  const bottomEdge = Math.max(
    MIN_PANEL_H + VIEWPORT_MARGIN,
    Math.min(wantedBottomEdge, window.innerHeight - VIEWPORT_MARGIN),
  );
  return {
    bottom: window.innerHeight - bottomEdge,
    maxHeight: Math.max(MIN_PANEL_H, Math.min(idealH, bottomEdge - VIEWPORT_MARGIN)),
  };
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
  onEditModels,
  effort,
  onEffortChange,
  thinkingEnabled,
  onThinkingChange,
  openSignal,
}: {
  models: ModelItem[];
  visibleModels: ModelItem[];
  loading?: boolean;
  selected: ModelItem | null;
  onSelect: (m: ModelItem) => void;
  onEditModels?: () => void;
  effort: EffortLevel;
  onEffortChange: (v: EffortLevel) => void;
  thinkingEnabled: boolean;
  onThinkingChange: (v: boolean) => void;
  /** Incrementing counter — each change opens the menu (command palette). */
  openSignal?: number;
}) {
  const [pane, setPane] = useState<PaneKind | null>(null);
  // Provider whose models are revealed in the flyout (hover / tap).
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [modelsPos, setModelsPos] = useState<PanelPos | null>(null);
  const [flyoutPos, setFlyoutPos] = useState<AnchorPos | null>(null);
  const [effortPos, setEffortPos] = useState<PanelPos | null>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const effortChipRef = useRef<HTMLButtonElement>(null);
  const modelsPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openSignal) setPane('models');
  }, [openSignal]);

  const closeAll = useCallback(() => {
    setPane(null);
    setActiveProvider(null);
    setFlyoutPos(null);
  }, []);

  // Pin/unpin straight from the flyout: resolve the provider entry behind
  // the aggregated model, flip its `pinned` flag, refresh the catalog.
  const queryClient = useQueryClient();
  const { data: providersList } = useQuery({
    queryKey: ['ws-providers'],
    queryFn: () => providersApi.list(),
    staleTime: 30_000,
  });
  const toggleModelPin = useCallback(
    (m: ModelItem) => {
      const provider = (providersList ?? []).find(
        (p) => p.name === m.provider && p.models.some((mm) => mm.id === m.id),
      );
      if (!provider) return;
      const entry = provider.models.find((mm) => mm.id === m.id);
      void providersApi
        .updateModel(provider.id, m.id, { pinned: !entry?.pinned })
        .then(() => refreshProviderCatalog(queryClient));
    },
    [providersList, queryClient],
  );

  // Provider-grouped catalog, ranked like everywhere else (pinned → free →
  // name). Insertion order of the reduce preserves global rank for the
  // provider list, so the strongest provider floats to the top.
  const groups = useMemo(() => {
    const acc = new Map<string, ModelItem[]>();
    for (const m of visibleModels) {
      if (!acc.has(m.provider)) acc.set(m.provider, []);
      acc.get(m.provider)!.push(m);
    }
    const out: { provider: string; models: ModelItem[] }[] = [];
    for (const [provider, list] of acc) {
      out.push({ provider, models: [...list].sort(compareModelsRanked) });
    }
    return out;
  }, [visibleModels]);

  // Which provider's models are shown: explicit hover/tap wins, then the
  // selected model's provider, then the first group.
  const effectiveProvider =
    activeProvider ??
    groups.find((g) => g.provider === selected?.provider)?.provider ??
    groups[0]?.provider ??
    null;
  const activeGroup = groups.find((g) => g.provider === effectiveProvider) ?? null;

  // Position the panels once on open (above the chips, like the reference);
  // reset the flyout whenever the pane closes.
  useEffect(() => {
    if (!pane) {
      setModelsPos(null);
      setEffortPos(null);
      setFlyoutPos(null);
      setActiveProvider(null);
      return;
    }
    if (pane === 'models') {
      const el = modelChipRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        setModelsPos({
          left: clampLeft(r.right - MODELS_PANEL_W, MODELS_PANEL_W),
          ...anchorAbove(r.top, MODELS_PANEL_H),
        });
      }
      setEffortPos(null);
    } else {
      const el = effortChipRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        setEffortPos({
          left: clampLeft(r.right - EFFORT_PANEL_W, EFFORT_PANEL_W),
          ...anchorAbove(r.top, EFFORT_PANEL_H),
        });
      }
      setModelsPos(null);
    }
  }, [pane]);

  useEffect(() => {
    if (!pane) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeAll();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (modelChipRef.current?.contains(target)) return;
      if (effortChipRef.current?.contains(target)) return;
      if (modelsPanelRef.current?.contains(target)) return;
      closeAll();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pane, closeAll]);

  // Flyout geometry: beside the models panel, top near the hovered row,
  // flipping to the left side when the right edge would overflow.
  const updateFlyoutPos = useCallback((rowEl: HTMLElement) => {
    const panelRect = modelsPanelRef.current?.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    const panelRight = panelRect?.right ?? rowRect.right;
    const flip = panelRight + FLYOUT_W + 8 > window.innerWidth;
    setFlyoutPos({
      top: clampTop(rowRect.top - 6, FLYOUT_H),
      left: flip
        ? clampLeft((panelRect?.left ?? rowRect.left) - FLYOUT_W - 8, FLYOUT_W)
        : clampLeft(panelRight + 8, FLYOUT_W),
    });
  }, []);

  // Default flyout: opening the pane immediately reveals the selected
  // provider's models (the reference screenshot's resting state) — no
  // hover required. Once the user hovers another row, that wins.
  useEffect(() => {
    if (pane !== 'models' || !modelsPos || flyoutPos) return;
    const rows = modelsPanelRef.current?.querySelectorAll<HTMLButtonElement>('button[data-testid^="provider-row-"]');
    const wanted = `provider-row-${effectiveProvider ?? ''}`;
    for (const row of rows ?? []) {
      if (row.dataset.testid === wanted) {
        updateFlyoutPos(row);
        break;
      }
    }
  }, [pane, modelsPos, flyoutPos, effectiveProvider, updateFlyoutPos]);

  const onProviderHover = useCallback(
    (provider: string) => (e: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>) => {
      setActiveProvider(provider);
      updateFlyoutPos(e.currentTarget);
    },
    [updateFlyoutPos],
  );

  const modelRow = (m: ModelItem) => {
    const isSel = selected?.id === m.id && selected?.provider === m.provider;
    return (
      <div
        key={`${m.provider}/${m.id}`}
        {...menuItem}
        role="button"
        tabIndex={0}
        data-testid="model-option"
        className="group flex w-full cursor-pointer items-center gap-1 py-1 pl-2 pr-1.5 text-left text-xs hover:bg-muted/50"
        onClick={() => {
          onSelect(m);
          closeAll();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(m);
            closeAll();
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate text-foreground">
          {m.id || m.name}
        </span>
        <button
          type="button"
          title={m.pinned ? 'Unpin' : 'Pin'}
          onClick={(e) => {
            e.stopPropagation();
            toggleModelPin(m);
          }}
          className={cn(
            'shrink-0 cursor-pointer',
            m.pinned
              ? 'text-primary'
              : 'text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-foreground',
          )}
        >
          <Pin className="size-3" />
        </button>
        {isSel && <Check className="size-3.5 shrink-0 text-primary" />}
      </div>
    );
  };

  const effortOpt = EFFORT_OPTIONS.find((o) => o.value === effort) || EFFORT_OPTIONS[1];
  const modelsOpen = pane === 'models' && modelsPos !== null;
  const effortOpen = pane === 'effort' && effortPos !== null;

  return (
    <>
      {/* Model chip — Provider/model, like the reference composer. */}
      <motion.button
        ref={modelChipRef}
        type="button"
        {...chipTrigger}
        onClick={() => (pane === 'models' ? closeAll() : setPane('models'))}
        className={cn(
          'relative inline-flex items-center gap-1 text-xs outline-none cursor-pointer h-8 max-w-[260px]',
          'text-muted-foreground hover:text-foreground transition-colors duration-200',
          'bg-muted/40 hover:bg-muted/60 rounded-full px-2.5 py-1',
        )}
        title={selected ? `${selected.provider}/${selected.id}` : 'Select model'}
        aria-expanded={pane === 'models'}
        aria-haspopup="dialog"
        data-testid="model-chip"
      >
        <span className="min-w-0 truncate font-medium text-foreground">
          {chipModelLabel(selected)}
        </span>
        <ChevronRight
          className={cn(
            'size-3 shrink-0 opacity-60 transition-transform duration-200',
            modelsOpen && 'rotate-90',
          )}
        />
      </motion.button>

      {/* Effort chip — icon + effort word, its own pane. */}
      <motion.button
        ref={effortChipRef}
        type="button"
        {...chipTrigger}
        onClick={() => (pane === 'effort' ? closeAll() : setPane('effort'))}
        className={cn(
          'relative inline-flex items-center gap-1 text-xs outline-none cursor-pointer h-8',
          'text-muted-foreground hover:text-foreground transition-colors duration-200',
          'bg-muted/40 hover:bg-muted/60 rounded-full px-2.5 py-1',
        )}
        title={`Effort: ${effortOpt.label} · extended thinking ${thinkingEnabled ? 'on' : 'off'}`}
        aria-expanded={pane === 'effort'}
        aria-haspopup="dialog"
        data-testid="effort-chip"
      >
        <Gauge className="size-3.5 shrink-0 opacity-70" />
        <span className="shrink-0">{effortOpt.triggerLabel}</span>
        <ChevronRight
          className={cn(
            'size-3 shrink-0 opacity-60 transition-transform duration-200',
            effortOpen && 'rotate-90',
          )}
        />
      </motion.button>

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {modelsOpen && modelsPos && (
              <motion.div
                ref={modelsPanelRef}
                {...menuPanel}
                className="fixed z-50 flex flex-col bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden"
                style={{
                  bottom: modelsPos.bottom,
                  left: modelsPos.left,
                  width: MODELS_PANEL_W,
                  maxHeight: modelsPos.maxHeight,
                }}
                data-testid="model-effort-menu"
              >
                <div
                  data-testid="models-panel-list"
                  className="py-1 overflow-y-auto min-h-0 flex-1 chat-scroll"
                >
                  {groups.length === 0 && (
                    <div className="px-2 py-2 text-[11px] text-muted-foreground">
                      {loading ? 'Loading…' : 'No providers.'}
                    </div>
                  )}
                  {groups.map((g) => {
                    const isActive = g.provider === effectiveProvider;
                    const isCur = g.provider === selected?.provider;
                    return (
                      <button
                        key={`p_${g.provider}`}
                        type="button"
                        data-testid={`provider-row-${g.provider}`}
                        onMouseEnter={onProviderHover(g.provider)}
                        onFocus={onProviderHover(g.provider)}
                        onClick={(e) => {
                          setActiveProvider(g.provider);
                          updateFlyoutPos(e.currentTarget);
                        }}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-1.5 px-3 py-[7px] text-left text-[13px] transition-colors',
                          isActive
                            ? 'bg-muted/60 text-foreground'
                            : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                        )}
                      >
                        {isCur && <Check className="size-3 shrink-0 text-primary" />}
                        <span className="min-w-0 flex-1 truncate">{g.provider}</span>
                        <ChevronRight
                          className={cn(
                            'size-3 shrink-0 transition-opacity',
                            isActive ? 'opacity-90' : 'opacity-30',
                          )}
                        />
                      </button>
                    );
                  })}
                </div>
                {onEditModels && (
                  <>
                    <div className="mx-2 my-1 border-t border-border/40" />
                    <button
                      type="button"
                      onClick={() => {
                        closeAll();
                        onEditModels();
                      }}
                      className="w-full cursor-pointer px-3 py-2 text-left text-[12px] text-foreground/90 hover:bg-muted/40"
                      data-testid="manage-models"
                    >
                      Manage models
                    </button>
                  </>
                )}
              </motion.div>
            )}
            {modelsOpen && flyoutPos && activeGroup && (
              <motion.div
                {...menuPanel}
                className="fixed z-50 bg-popover border border-border/60 rounded-xl shadow-2xl overflow-y-auto py-1 chat-scroll"
                style={{ top: flyoutPos.top, left: flyoutPos.left, width: FLYOUT_W, maxHeight: FLYOUT_H }}
                data-testid="provider-models-flyout"
              >
                {activeGroup.models.length > 0 ? (
                  activeGroup.models.map((m) => modelRow(m))
                ) : (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No models.</div>
                )}
              </motion.div>
            )}
            {effortOpen && effortPos && (
              <motion.div
                {...menuPanel}
                className="fixed z-50 flex flex-col bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden"
                style={{
                  bottom: effortPos.bottom,
                  left: effortPos.left,
                  width: EFFORT_PANEL_W,
                  maxHeight: effortPos.maxHeight,
                }}
                data-testid="effort-menu"
              >
                <div className="min-h-0 flex-1 overflow-y-auto py-1 chat-scroll">
                  {EFFORT_OPTIONS.map((o) => {
                    const isSel = effort === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSel}
                        data-testid={`effort-option-${o.triggerLabel}`}
                        onClick={() => onEffortChange(o.value)}
                        className={cn(
                          'flex w-full cursor-pointer items-center justify-between px-3 py-[7px] text-left text-[13px] transition-colors',
                          isSel
                            ? 'text-foreground'
                            : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                        )}
                      >
                        <span>{o.triggerLabel}</span>
                        {isSel && <Check className="size-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/40 px-3 py-2">
                  <span className="text-[11px] text-muted-foreground">Extended thinking</span>
                  <ThinkingSwitch checked={thinkingEnabled} onChange={onThinkingChange} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
