/* ── Combined model + effort menu ─────────────────────────────────────── */
/* Two-card picker, matching the reference:
 *
 *   ┌──────────────────────────────┐ ┌──────────────────┐
 *   │ provider mark  Provider  API >│ │ OpenCode GO  API ✓│
 *   │ Models                       │ │ OpenCode ZEN API  │
 *   │   model id          Vision ✓ │ │ …                 │
 *   │ Effort  Max          Ctrl+T   │ │ New provider API  │
 *   │   ─────────────●             │ │ ───────────────── │
 *   │                              │ │ Manage models     │
 *   └──────────────────────────────┘ └──────────────────┘
 *
 * The left card is the active provider's model list plus the effort slider.
 * The right card is the provider rail, opened from the header chevron. The
 * old single-list-with-inline-provider-headers layout is gone: the reference
 * separates the two decisions, so the provider rail can stay open while the
 * model list changes underneath it.
 *
 * The model list intentionally shows the raw id (as the reference does) and
 * no price/wire/context metadata; those remain in the expanded model settings
 * and in each row's title. The effort pane (the small chip beside the model
 * chip) keeps the extended-thinking switch; the slider in the model card is
 * the same effort state.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { chipTrigger, menuFlyout, menuPanel } from '@/lib/motion';
import { groupModelsByProvider, modelMatchesQuery } from '@/components/model/modelList';
import type { ModelItem } from '../model-display';
import { modelDisplayParts } from '../model-display';
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

/** Chip label: `Provider · Model`, kept from the composer's existing contract. */
function chipVariant(model: ModelItem, tag: string): string {
  if (!tag) return '';
  const colon = tag.indexOf(':');
  if (colon >= 0) return tag.slice(colon + 1);
  return /[/:]/.test(model.id) ? '' : tag;
}

export function chipModelLabel(model: ModelItem | null): string {
  if (!model) return 'Model';
  const { name, tag } = modelRowLabel(model);
  const variant = chipVariant(model, tag);
  const label = variant ? `${name} (${variant})` : name;
  const raw = model.provider ? `${model.provider} · ${label}` : label;
  return raw.length > 34 ? `${raw.slice(0, 32)}…` : raw;
}

/** Row label for the trigger chip; the panel itself prints the raw id. */
function modelRowLabel(model: ModelItem): { name: string; tag: string } {
  if (model.name && model.name !== model.id) return { name: model.name, tag: '' };
  const parts = modelDisplayParts(model.id || model.name);
  const tag = parts.tag.toLowerCase() === model.provider.toLowerCase() ? '' : parts.tag;
  return { name: parts.name, tag };
}


/** Composer-anchored panels: positioned by their BOTTOM edge (CSS bottom +
 *  clamped maxHeight) so short lists hug the chip instead of floating far
 *  above it. The provider rail is positioned by its TOP edge after the model
 *  card has rendered, so it can extend below it like the reference. */
type PanelPos = { left: number; bottom: number; maxHeight: number };
type ProviderPos = { left: number; top: number; maxHeight: number };

const MODELS_PANEL_W = 304;
const MODELS_PANEL_H = 520;
const MODELS_PANEL_MIN_H = 216;
const PROVIDER_PANEL_W = 184;
/** Gap between the panel's bottom edge and the trigger chip. */
const PANEL_GAP = 8;
/** Viewport margin kept clear above/below a panel. */
const VIEWPORT_MARGIN = 8;
/** Never shrink below this — the list scrolls internally instead. */
const MIN_PANEL_H = 96;

function clampLeft(left: number, w: number): number {
  return Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - w - VIEWPORT_MARGIN));
}

/**
 * Bottom-edge anchoring (Zed/Cursor style): the panel's bottom edge sits
 * PANEL_GAP above the chip's top and the panel grows upward only as far
 * as the viewport allows.
 */
function anchorAbove(chipTop: number, idealH: number): { bottom: number; maxHeight: number } {
  const wantedBottomEdge = chipTop - PANEL_GAP;
  const bottomEdge = Math.max(
    MIN_PANEL_H + VIEWPORT_MARGIN,
    Math.min(wantedBottomEdge, window.innerHeight - VIEWPORT_MARGIN),
  );
  return {
    bottom: window.innerHeight - bottomEdge,
    maxHeight: Math.max(MIN_PANEL_H, Math.min(idealH, bottomEdge - VIEWPORT_MARGIN)),
  };
}

function ProviderMark({ provider }: { provider: string }) {
  const initial = provider.trim().charAt(0).toUpperCase() || 'P';
  return (
    <span
      className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-border/60 bg-muted/50 text-[0.625rem] font-semibold leading-none text-foreground/75"
      aria-hidden
    >
      {initial}
    </span>
  );
}

function ApiBadge() {
  return (
    <span className="shrink-0 rounded-[3px] border border-border/60 px-1 py-[1px] text-[0.5rem] font-medium uppercase tracking-[0.06em] leading-3 text-muted-foreground/70">
      API
    </span>
  );
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
}: {
  visibleModels: ModelItem[];
  loading?: boolean;
  selected: ModelItem | null;
  onSelect: (m: ModelItem) => void;
  onEditModels?: () => void;
  effort: EffortLevel;
  onEffortChange: (v: EffortLevel) => void;
  thinkingEnabled: boolean;
  onThinkingChange: (v: boolean) => void;
}) {
  // One pane now: the effort chip was removed, so the picker is open or closed.
  const [pane, setPane] = useState<'models' | null>(null);
  const [modelsPos, setModelsPos] = useState<PanelPos | null>(null);
  const [providerPos, setProviderPos] = useState<ProviderPos | null>(null);
  const [showProviders, setShowProviders] = useState(false);
  const [activeProvider, setActiveProvider] = useState('');
  const [query, setQuery] = useState('');

  const modelChipRef = useRef<HTMLButtonElement>(null);
  const modelsPanelRef = useRef<HTMLDivElement>(null);
  const providerPanelRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupModelsByProvider(visibleModels), [visibleModels]);
  const activeGroup =
    groups.find((g) => g.provider === activeProvider) ?? groups[0] ?? null;
  const activeProviderName = activeGroup?.provider ?? '';
  // Preserve the provider's own model order in this picker. The shared
  // grouper sorts (pinned/free/name) for the settings surfaces; the reference
  // keeps the catalog order here.
  const activeModels = useMemo(
    () => visibleModels.filter((m) => m.provider === activeProviderName),
    [activeProviderName, visibleModels],
  );
  const searching = query.trim().length > 0;
  // Search is cross-provider: the model id the user types may live under a
  // provider whose rail is not the active one. The results keep the catalog's
  // order and show the provider on the row.
  const searchResults = useMemo(
    () => (searching ? visibleModels.filter((m) => modelMatchesQuery(m, query)) : []),
    [query, searching, visibleModels],
  );

  const effortIndex = Math.max(
    0,
    EFFORT_OPTIONS.findIndex((o) => o.value === effort),
  );
  const effortOpt = EFFORT_OPTIONS[effortIndex] ?? EFFORT_OPTIONS[1];

  const cycleEffort = useCallback(() => {
    const next = EFFORT_OPTIONS[(effortIndex + 1) % EFFORT_OPTIONS.length];
    if (next) onEffortChange(next.value);
  }, [effortIndex, onEffortChange]);

  const openModels = useCallback(() => {
    if (pane === 'models') {
      setPane(null);
      return;
    }
    const preferred =
      selected && groups.some((g) => g.provider === selected.provider)
        ? selected.provider
        : groups[0]?.provider ?? '';
    setActiveProvider(preferred);
    setShowProviders(false);
    setQuery('');
    setPane('models');
  }, [groups, pane, selected]);

  const closeAll = useCallback(() => {
    setPane(null);
  }, []);

  const toggleProviders = useCallback(() => {
    if (!showProviders) {
      const needed = MODELS_PANEL_W + 2 + PROVIDER_PANEL_W;
      setModelsPos((prev) => {
        if (!prev) return prev;
        const maxLeft = window.innerWidth - needed - VIEWPORT_MARGIN;
        return { ...prev, left: Math.max(VIEWPORT_MARGIN, Math.min(prev.left, maxLeft)) };
      });
    }
    setShowProviders((open) => !open);
  }, [showProviders]);

  const isNavigateTarget = (el: HTMLElement): boolean => {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };

  const focusItem = (container: HTMLElement | null, mode: 'next' | 'prev' | 'first' | 'last') => {
    if (!container) return;
    const found = new Set<HTMLElement>();
    for (const el of container.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')) {
      if (isNavigateTarget(el)) found.add(el);
    }
    const items = [...found];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let index: number;
    if (mode === 'first') index = 0;
    else if (mode === 'last') index = items.length - 1;
    else if (current === -1) index = mode === 'next' ? 0 : items.length - 1;
    else index = (current + (mode === 'next' ? 1 : -1) + items.length) % items.length;
    items[index]?.focus();
  };

  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      cycleEffort();
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(e.currentTarget, 'next');
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(e.currentTarget, 'prev');
        break;
      case 'Home':
        e.preventDefault();
        focusItem(e.currentTarget, 'first');
        break;
      case 'End':
        e.preventDefault();
        focusItem(e.currentTarget, 'last');
        break;
      default:
        break;
    }
  };

  // Position the left panel when it opens. The provider rail is measured after
  // this card renders, so its top can line up with the card's top edge.
  useEffect(() => {
    if (!pane) {
      setModelsPos(null);
      setProviderPos(null);
      setShowProviders(false);
      setQuery('');
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
    } else {
      setModelsPos(null);
      setProviderPos(null);
    }
  }, [pane]);

  useLayoutEffect(() => {
    if (!showProviders || pane !== 'models' || !modelsPanelRef.current) {
      setProviderPos(null);
      return;
    }
    const rect = modelsPanelRef.current.getBoundingClientRect();
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.top),
      Math.max(VIEWPORT_MARGIN, window.innerHeight - 128),
    );
    setProviderPos({
      left: Math.min(
        rect.right + 2,
        window.innerWidth - PROVIDER_PANEL_W - VIEWPORT_MARGIN,
      ),
      top,
      maxHeight: Math.max(120, window.innerHeight - top - VIEWPORT_MARGIN),
    });
  }, [activeGroup?.provider, pane, showProviders]);

  // Focus the opened panel and restore the chip on close.
  const hasOpenedRef = useRef(false);
  useEffect(() => {
    if (pane) {
      hasOpenedRef.current = true;
      modelsPanelRef.current?.focus();
      return;
    }
    if (!hasOpenedRef.current) return;
    hasOpenedRef.current = false;
    modelChipRef.current?.focus();
  }, [pane, modelsPos]);

  useEffect(() => {
    if (!pane) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeAll();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (modelChipRef.current?.contains(target)) return;
      if (modelsPanelRef.current?.contains(target)) return;
      if (providerPanelRef.current?.contains(target)) return;
      closeAll();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pane, closeAll]);

  const modelRow = (m: ModelItem, showProvider = false) => {
    const isSelected = selected?.id === m.id && selected?.provider === m.provider;
    const meta = [
      `${m.provider}/${m.id}`,
      m.contextWindow > 0 ? `${m.contextWindow.toLocaleString()} tokens` : '',
      m.apiFormat ? `wire ${m.apiFormat}` : '',
      m.supportsReasoning ? 'reasoning' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <div
        key={`${m.provider}/${m.id}`}
        role="menuitem"
        tabIndex={0}
        data-testid="model-option"
        title={meta}
        aria-label={`${m.id}${isSelected ? ', selected' : ''}`}
        className="group flex min-h-8 w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left text-[0.8125rem] text-foreground/90 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
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
        <span className="min-w-0 flex-1 truncate">{m.id || m.name}</span>
        {showProvider ? (
          <span className="max-w-[34%] shrink-0 truncate text-2xs text-muted-foreground/60">
            {m.provider}
          </span>
        ) : null}
        {isSelected ? <Check className="size-3.5 shrink-0 text-foreground/80" /> : null}
      </div>
    );
  };

  const providerRow = (provider: string) => {
    const isActive = provider === activeProviderName;
    return (
      <button
        key={provider}
        type="button"
        role="menuitemradio"
        aria-checked={isActive}
        data-testid={`provider-group-${provider}`}
        onClick={() => setActiveProvider(provider)}
        className={cn(
          'flex h-8 w-full items-center gap-2 px-3 text-left text-[0.8125rem] transition-colors',
          isActive
            ? 'text-foreground'
            : 'text-muted-foreground/85 hover:bg-muted/40 hover:text-foreground',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{provider}</span>
        <ApiBadge />
        {isActive ? <Check className="size-3.5 shrink-0 text-foreground/80" /> : null}
      </button>
    );
  };

  const modelsOpen = pane === 'models' && modelsPos !== null;
  const providersOpen = modelsOpen && showProviders && providerPos !== null;

  return (
    <>
      <div className="inline-flex min-w-0 shrink-0 items-center gap-1" data-testid="model-effort-control">
        <motion.button
          ref={modelChipRef}
          type="button"
          {...chipTrigger}
          onClick={openModels}
          className={cn(
            'group relative inline-flex h-6 max-w-[220px] cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.75rem] text-foreground/85 outline-none transition-colors duration-200 hover:bg-muted/50 hover:text-foreground',
          )}
          title={selected ? `${selected.provider}/${selected.id}` : 'Select model'}
          aria-expanded={pane === 'models'}
          aria-haspopup="dialog"
          data-testid="model-chip"
        >
          <span className="min-w-0 truncate font-medium">{chipModelLabel(selected)}</span>
          {/* Visible at rest. The chevron was opacity-0 until hover, so the chip
              read as a label rather than a control and nothing invited the
              click — the affordance only appeared on the element you had to
              hover to discover. */}
          <ChevronDown
            className={cn(
              'size-3 shrink-0 opacity-60 transition-transform duration-200',
              modelsOpen && 'rotate-180',
            )}
          />
        </motion.button>
      </div>

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {modelsOpen && modelsPos && (
              <motion.div
                key="models-panel"
                ref={modelsPanelRef}
                {...menuPanel}
                role="menu"
                aria-label="Model and effort"
                tabIndex={-1}
                onKeyDown={onPanelKeyDown}
                className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border/60 bg-popover shadow-2xl"
                style={{
                  bottom: modelsPos.bottom,
                  left: modelsPos.left,
                  width: MODELS_PANEL_W,
                  minHeight: Math.min(MODELS_PANEL_MIN_H, modelsPos.maxHeight),
                  maxHeight: modelsPos.maxHeight,
                }}
                data-testid="model-effort-menu"
              >
                {/* The whole header is the control, not just the chevron. It
                    used to be a div with a 20px button holding the arrow, so
                    the provider name — the one thing you look at to know what
                    you're about to change — did nothing when you clicked it. */}
                <button
                  type="button"
                  onClick={toggleProviders}
                  aria-label={`Change provider — currently ${activeProviderName || 'no provider'}`}
                  aria-expanded={showProviders}
                  aria-controls="model-provider-panel"
                  data-testid="model-provider-toggle"
                  className="flex h-11 w-full shrink-0 items-center gap-2 border-b border-border/40 px-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                >
                  <ProviderMark provider={activeProviderName} />
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold leading-5 text-foreground">
                    {activeProviderName || 'Provider'}
                  </span>
                  <ApiBadge />
                  <ChevronRight
                    className={cn(
                      'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
                      showProviders && 'rotate-90',
                    )}
                  />
                </button>

                <div className="shrink-0 px-2 pb-1 pt-1.5">
                  <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 transition-colors focus-within:border-primary/40">
                    <Search className="size-3 shrink-0 text-muted-foreground" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape' && query) {
                          e.preventDefault();
                          e.stopPropagation();
                          setQuery('');
                        }
                      }}
                      placeholder="Search models"
                      aria-label="Search models by name, ID or provider"
                      data-testid="model-search"
                      className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-foreground outline-none placeholder:text-muted-foreground"
                    />
                    {query ? (
                      <button
                        type="button"
                        onClick={() => setQuery('')}
                        aria-label="Clear model search"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="shrink-0 px-3 pb-1 pt-1 text-[0.625rem] font-medium leading-4 text-muted-foreground/70">
                  {searching ? 'Search results' : 'Models'}
                </div>

                <div
                  data-testid="models-panel-list"
                  className="min-h-0 flex-1 overflow-y-auto py-0.5 chat-scroll"
                >
                  {(searching ? searchResults : activeModels).length > 0 ? (
                    (searching ? searchResults : activeModels).map((m) =>
                      modelRow(m, searching),
                    )
                  ) : (
                    <div className="px-3 py-2 text-[0.8125rem] text-muted-foreground/70">
                      {loading
                        ? 'Loading…'
                        : searching
                          ? `No model matches “${query.trim()}”.`
                          : 'No models for this provider.'}
                    </div>
                  )}
                </div>

                <div className="shrink-0 border-t border-border/40 px-3 pb-2.5 pt-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[0.6875rem] leading-4 text-muted-foreground">Effort</span>
                      {/* Keyed on the level so a change FADES the new word in
                          instead of swapping it between frames — the knob is
                          already sliding underneath, and a hard word swap next
                          to it read as a different control updating. */}
                      <motion.span
                        key={effortOpt.value}
                        initial={{ opacity: 0, y: 3 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.16, ease: [0.2, 0.75, 0.2, 1] }}
                        className="text-[0.75rem] font-semibold leading-4 text-foreground"
                        data-testid="effort-value"
                      >
                        {effortOpt.triggerLabel}
                      </motion.span>
                    </div>
                    <button
                      type="button"
                      onClick={cycleEffort}
                      title="Cycle effort (Ctrl+T while this menu is open)"
                      className="rounded-[4px] border border-border/60 px-1.5 py-0.5 text-[0.5625rem] font-medium leading-3 text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
                    >
                      Ctrl+T
                    </button>
                  </div>
                  {/* The track and knob are DRAWN here and animated by CSS; the
                      range input sits invisibly on top as the real control, so
                      keyboard, screen readers and drag keep working while the
                      knob can slide between stops (a native thumb teleports,
                      and cannot be transitioned at all). `data-stop` picks the
                      thumb position from the stylesheet — no inline styles. */}
                  <div className="model-effort-track mt-2" data-stop={effortIndex}>
                    <span className="model-effort-knob" aria-hidden />
                    <input
                      type="range"
                      min={0}
                      max={EFFORT_OPTIONS.length - 1}
                      step={1}
                      value={effortIndex}
                      aria-label="Effort"
                      aria-valuetext={effortOpt.label}
                      onChange={(e) => {
                        const next = EFFORT_OPTIONS[Number(e.target.value)];
                        if (next) onEffortChange(next.value);
                      }}
                      className="model-effort-slider"
                    />
                  </div>
                  {/* The extended-thinking switch lived in its own effort
                      popover. That popover is gone — the effort row IS the
                      control now — so the switch moves in beside it rather
                      than becoming unreachable. */}
                  <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/40 pt-2">
                    <span className="text-2xs text-muted-foreground">Extended thinking</span>
                    <ThinkingSwitch checked={thinkingEnabled} onChange={onThinkingChange} />
                  </div>
                </div>
              </motion.div>
            )}

            {providersOpen && providerPos && (
              <motion.div
                key="provider-panel"
                ref={providerPanelRef}
                {...menuFlyout}
                id="model-provider-panel"
                role="menu"
                aria-label="Providers"
                tabIndex={-1}
                onKeyDown={onPanelKeyDown}
                className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border/60 bg-popover shadow-2xl"
                style={{
                  left: providerPos.left,
                  top: providerPos.top,
                  width: PROVIDER_PANEL_W,
                  maxHeight: providerPos.maxHeight,
                }}
                data-testid="model-provider-panel"
              >
                <div className="min-h-0 flex-1 overflow-y-auto py-1 chat-scroll">
                  {groups.length > 0 ? (
                    groups.map((g) => providerRow(g.provider))
                  ) : (
                    <div className="px-3 py-2 text-[0.8125rem] text-muted-foreground/70">
                      No providers.
                    </div>
                  )}
                  {onEditModels ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeAll();
                        onEditModels();
                      }}
                      data-testid="new-provider"
                      className="flex h-8 w-full items-center gap-2 px-3 text-left text-[0.8125rem] text-muted-foreground/85 transition-colors hover:bg-muted/40 hover:text-foreground"
                    >
                      <span className="min-w-0 flex-1 truncate">New provider</span>
                      <ApiBadge />
                    </button>
                  ) : null}
                </div>
                {onEditModels ? (
                  <div className="shrink-0 border-t border-border/40 p-1">
                    <button
                      type="button"
                      onClick={() => {
                        closeAll();
                        onEditModels();
                      }}
                      data-testid="manage-models"
                      className="w-full rounded-md px-2.5 py-2 text-left text-[0.8125rem] text-foreground/90 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                    >
                      Manage models
                    </button>
                  </div>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
