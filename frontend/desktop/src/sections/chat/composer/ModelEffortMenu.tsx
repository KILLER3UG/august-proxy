/* ── Combined model + effort menu ─────────────────────────────────────── */
/* Z.ai-style picker matching the reference screenshot: the model chip     */
/* opens a narrow provider list whose header block shows the CURRENT       */
/* provider + model ("Manage models" pinned at the bottom), and hovering   */
/* a provider slides a SEPARATE flyout card beside the panel with that     */
/* provider's models — plain rows, pin on hover, check on selected.        */
/* The effort chip opens a small pane with a vertical effort list (✓ on   */
/* the active row) + thinking toggle. The models panel carries a search    */
/* field: typing a model name replaces the provider list with a flat,     */
/* cross-provider result set, which is the one thing the two-level layout  */
/* cannot do on its own.                                                  */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Gauge, Pin, RefreshCw, Search, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { chipTrigger, menuPanel, menuItem } from '@/lib/motion';
import { providersApi } from '@/api/providers';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import type { ModelItem } from '../model-display';
import { groupModelsByProvider } from '@/components/model/modelList';
import { compareModelsRanked, modelDisplayParts } from '../model-display';
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

/** Chip label: `Provider · Model`. It used to print `Provider/model-id`, which
 *  truncated an identifier mid-id ("KiloCode/ox-alpha-free" → "KiloCode/ox-alp…")
 *  while every list in the very popover it opens said "Ox Alpha Free". The exact
 *  id stays available on hover, and in each row's tooltip. */
/** The tier word a chip has room for: `poolside:Free` → `Free`; a tag that is
 *  only a vendor slug (`poolside`) → nothing; a bare `Free` from an id that
 *  carries no prefix → `Free`. */
function chipVariant(model: ModelItem, tag: string): string {
  if (!tag) return '';
  const colon = tag.indexOf(':');
  if (colon >= 0) return tag.slice(colon + 1);
  return /[/:]/.test(model.id) ? '' : tag;
}

export function chipModelLabel(model: ModelItem | null): string {
  if (!model) return 'Model';
  const { name, tag } = modelRowLabel(model);
  // The chip has room for the tier, not the vendor slug — that is what the panel
  // header and each row's own badge are for, and
  // "KiloCode · Step 3.7 Flash stepfun:Free" overflowed it.
  const variant = chipVariant(model, tag);
  const label = variant ? `${name} (${variant})` : name;
  const raw = model.provider ? `${model.provider} · ${label}` : label;
  return raw.length > 34 ? `${raw.slice(0, 32)}…` : raw;
}

/** Row label: the catalog's friendly name when it carries one, else the
 *  prettified id with its variant split into a tag (the rule the model lists
 *  and the idle dropdown already use). `m.name` alone is not enough —
 *  `useChatModels` sets `name = name || id`, so it can still be an identifier. */
function modelRowLabel(model: ModelItem): { name: string; tag: string } {
  if (model.name && model.name !== model.id) return { name: model.name, tag: '' };
  const parts = modelDisplayParts(model.id || model.name);
  // `modelDisplayParts` puts the id's provider prefix in `tag`. In this panel the
  // provider is the group header — or the right-hand column of a search hit — so
  // "Sonnet 4 5 / anthropic" under "Anthropic" says the same thing twice.
  const tag = parts.tag.toLowerCase() === model.provider.toLowerCase() ? '' : parts.tag;
  return { name: parts.name, tag };
}

/** Search is separator-agnostic: ids use `-`, `_`, `/` and `:` where a person
 *  types a space, so "claude sonnet" has to reach `anthropic/claude-sonnet-4-5`
 *  and "kimi k3" has to reach `kimi-k3`. Both sides collapse the same way. */
const searchNormalize = (text: string): string =>
  text.toLowerCase().replace(/[-_/:]/g, ' ').replace(/\s+/g, ' ').trim();

const searchHaystack = (model: ModelItem): string => {
  const parts = modelRowLabel(model);
  return searchNormalize(
    `${model.id} ${model.name ?? ''} ${model.provider} ${parts.name} ${parts.tag}`,
  );
};

type PaneKind = 'models' | 'effort';

type AnchorPos = { top: number; left: number };

/** Composer-anchored panels: positioned by their BOTTOM edge (CSS bottom +
 *  clamped maxHeight) so short lists hug the chip instead of floating far
 *  above it. */
type PanelPos = { left: number; bottom: number; maxHeight: number };

const MODELS_PANEL_W = 232;
/** Ideal heights — panels render shorter than these when room is tight. */
const MODELS_PANEL_H = 420;
const EFFORT_PANEL_H = 150;
const FLYOUT_W = 232;
const FLYOUT_H = 340;
const EFFORT_PANEL_W = 264;

/** Gap between the panel's bottom edge and the trigger chip. */
const PANEL_GAP = 8;
/** Viewport margin kept clear above/below a panel. */
const VIEWPORT_MARGIN = 8;
/** Never shrink below this — the list scrolls internally instead. */
const MIN_PANEL_H = 96;
/** Ceiling on rendered search hits, so a one-letter query cannot mount
 *  hundreds of rows; `search.hidden` tells the user what the cap dropped. */
const SEARCH_RESULT_CAP = 80;

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
  // Model-name search. Non-empty query swaps the provider list for a flat
  // cross-provider result set — the two-level layout can't reach a model
  // without the user knowing which provider filed it under.
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const effortChipRef = useRef<HTMLButtonElement>(null);
  const modelsPanelRef = useRef<HTMLDivElement>(null);
  // The effort panel and the models flyout live OUTSIDE modelsPanelRef in the
  // portal — without their own refs, mousedown on a row inside them would
  // hit the outside-click handler and close the menu before the click could
  // land, making options silently fail to switch.
  const effortPanelRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);

  // ── Keyboard: roving focus through the open panel ──────────────────────
  // Every row here was mouse-only: ArrowDown did nothing and Tab walked out
  // of the menu entirely, which made the highest-frequency picker in the
  // composer unusable without a pointer. Provider rows already reveal their
  // models on focus, so moving focus is enough to drive the flyout too.
  const lastPaneRef = useRef<PaneKind | null>(null);

  // Visibility check is style-based, not layout-based, on purpose. Neither of
  // the usual shortcuts works here: these panels are fixed-position portals,
  // so `offsetParent` is null for every row, and jsdom returns an empty
  // `getClientRects()` for everything, which would make roving focus silently
  // dead in tests while looking correct in a browser.
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
    // The search field is INSIDE the panel, and its arrows belong to text
    // editing (Home/End to the caret). Without this the roving focus swallowed
    // the key and moved out of the field the user was typing in.
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const inFlyout = e.currentTarget === flyoutRef.current;
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
      case 'ArrowRight':
        // Provider list → its models. The flyout is already positioned by the
        // row's focus handler, so focusing it is enough.
        if (!inFlyout && flyoutRef.current) {
          e.preventDefault();
          flyoutRef.current.focus();
          focusItem(flyoutRef.current, 'first');
        }
        break;
      case 'ArrowLeft':
        if (inFlyout) {
          e.preventDefault();
          modelsPanelRef.current?.focus();
        }
        break;
      default:
        break;
    }
  };

  // Move focus into the panel that just opened, and back to the chip that
  // opened it when it closes. Keyed on the position state as well: the panels
  // render into a portal and only exist once their coordinates are computed.
  // `hasOpenedRef` stops the mount run: with `pane === null` on first render
  // the "restore" branch would fire and yank initial focus into the model
  // chip, leaving the composer textarea without focus.
  const hasOpenedRef = useRef(false);
  useEffect(() => {
    if (pane) {
      hasOpenedRef.current = true;
      lastPaneRef.current = pane;
      const panel = pane === 'models' ? modelsPanelRef.current : effortPanelRef.current;
      panel?.focus();
      return;
    }
    if (!hasOpenedRef.current) return;
    hasOpenedRef.current = false;
    const chip = lastPaneRef.current === 'effort' ? effortChipRef.current : modelChipRef.current;
    lastPaneRef.current = null;
    chip?.focus();
  }, [pane, modelsPos, effortPos]);

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

  // Refresh all providers: re-fetches every enabled provider's /models
  // endpoint, then invalidates the client catalog so this dropdown, the
  // settings tabs, and the chat composer all show the new list. Gated on
  // the dropdown being open so it never fires in the background.
  const refreshAll = useMutation({
    mutationFn: () => providersApi.refreshAllModels(),
    onSuccess: async (res) => {
      const added = res.added ?? 0;
      const refreshed = res.refreshed ?? 0;
      const failed = res.failed ?? 0;
      if (refreshed > 0) {
        toast.success(
          `Refreshed models${added ? ` (+${added} new)` : ''} across ${refreshed} provider${refreshed === 1 ? '' : 's'}`,
        );
      } else if (failed > 0) {
        toast.error(`Refresh failed for ${failed} provider${failed === 1 ? '' : 's'}`);
      } else {
        toast.message('No changes to model catalog');
      }
      await refreshProviderCatalog(queryClient);
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Refresh failed');
    },
  });

  // Provider-grouped catalog, ranked like everywhere else — the shared
  // primitive, so pinning and provider ordering behave identically in this
  // composer, the settings dropdown and the visibility modal. Insertion order
  // of the grouping preserves global rank for the provider list, so the
  // strongest provider floats to the top.
  const groups = useMemo(() => groupModelsByProvider(visibleModels), [visibleModels]);

  // Which provider's models are shown: explicit hover/tap wins, then the
  // selected model's provider, then the first group.
  const effectiveProvider =
    activeProvider ??
    groups.find((g) => g.provider === selected?.provider)?.provider ??
    groups[0]?.provider ??
    null;
  const activeGroup = groups.find((g) => g.provider === effectiveProvider) ?? null;

  const searching = query.trim().length > 0;
  // `hidden` is what the cap dropped: a long list cut off without a word looks
  // like "no other model matches".
  const search = useMemo(() => {
    const q = searchNormalize(query);
    if (!q) return { results: [] as ModelItem[], hidden: 0 };
    const matched = visibleModels
      .filter((m) => searchHaystack(m).includes(q))
      .sort(compareModelsRanked);
    return {
      results: matched.slice(0, SEARCH_RESULT_CAP),
      hidden: Math.max(0, matched.length - SEARCH_RESULT_CAP),
    };
  }, [query, visibleModels]);

  // Position the panels once on open (above the chips, like the reference);
  // reset the flyout whenever the pane closes.
  useEffect(() => {
    if (!pane) {
      setModelsPos(null);
      setEffortPos(null);
      setFlyoutPos(null);
      setActiveProvider(null);
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
      if (effortPanelRef.current?.contains(target)) return;
      if (flyoutRef.current?.contains(target)) return;
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

  const modelRow = (m: ModelItem, showProvider = false) => {
    const isSel = selected?.id === m.id && selected?.provider === m.provider;
    const { name, tag } = modelRowLabel(m);
    return (
      <div
        key={`${m.provider}/${m.id}`}
        {...menuItem}
        role="button"
        tabIndex={0}
        data-testid="model-option"
        title={`${m.provider}/${m.id}`}
        className="group flex w-full cursor-pointer items-center gap-1.5 py-[8px] pl-3 pr-2 text-left text-[0.875rem] hover:bg-muted/50"
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
          {name}
          {tag && (
            <span className="ml-1.5 text-2xs text-muted-foreground/60">{tag}</span>
          )}
        </span>
        {showProvider && (
          <span className="max-w-[38%] shrink-0 truncate text-2xs text-muted-foreground">
            {m.provider}
          </span>
        )}
        <button
          type="button"
          title={m.pinned ? 'Unpin' : 'Pin'}
          aria-label={m.pinned ? 'Unpin' : 'Pin'}
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
        {isSel && <Check className="size-3 shrink-0 text-primary" />}
      </div>
    );
  };

  const effortOpt = EFFORT_OPTIONS.find((o) => o.value === effort) || EFFORT_OPTIONS[1];
  const modelsOpen = pane === 'models' && modelsPos !== null;
  const effortOpen = pane === 'effort' && effortPos !== null;

  return (
    <>
      {/* Model chip — Provider · model name; the exact id is the tooltip. */}
      <motion.button
        ref={modelChipRef}
        type="button"
        {...chipTrigger}
        onClick={() => (pane === 'models' ? closeAll() : setPane('models'))}
        className={cn(
          'relative inline-flex items-center gap-1 text-[0.75rem] outline-none cursor-pointer h-7 max-w-[240px]',
          'text-muted-foreground hover:text-foreground transition-colors duration-200',
          'bg-muted/30 hover:bg-muted/50 rounded-lg px-2 py-0.5',
        )}
        title={selected ? `${selected.provider}/${selected.id}` : 'Select model'}
        aria-expanded={pane === 'models'}
        aria-haspopup="dialog"
        data-testid="model-chip"
      >
        <span className="min-w-0 truncate font-medium text-foreground">
          {chipModelLabel(selected)}
        </span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 opacity-60 transition-transform duration-200',
            modelsOpen && 'rotate-180',
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
          'relative inline-flex items-center gap-1 text-[0.75rem] outline-none cursor-pointer h-7',
          'text-muted-foreground hover:text-foreground transition-colors duration-200',
          'bg-muted/30 hover:bg-muted/50 rounded-lg px-2 py-0.5',
        )}
        title={`Effort: ${effortOpt.label} · extended thinking ${thinkingEnabled ? 'on' : 'off'}`}
        aria-expanded={pane === 'effort'}
        aria-haspopup="dialog"
        data-testid="effort-chip"
      >
        <Gauge className="size-3 shrink-0 opacity-70" />
        <span className="shrink-0">{effortOpt.triggerLabel}</span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 opacity-60 transition-transform duration-200',
            effortOpen && 'rotate-180',
          )}
        />
      </motion.button>

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {modelsOpen && modelsPos && (
              <motion.div
                key="models-panel"
                ref={modelsPanelRef}
                {...menuPanel}
                tabIndex={-1}
                onKeyDown={onPanelKeyDown}
                className="fixed z-50 flex flex-col bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden"
                style={{
                  bottom: modelsPos.bottom,
                  left: modelsPos.left,
                  width: MODELS_PANEL_W,
                  maxHeight: modelsPos.maxHeight,
                }}
                data-testid="model-effort-menu"
              >
                {/* Current-selection header — provider over model, like the
                    reference's "Z.ai / GLM-5.3-Flash" block. */}
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/40 py-2.5 pl-3 pr-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.9375rem] font-semibold leading-5 text-foreground">
                      {selected?.provider || 'Provider'}
                    </div>
                    <div className="truncate text-[0.8125rem] leading-5 text-foreground/80">
                      {selected ? modelRowLabel(selected).name : 'No model selected'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      // Keep the dropdown open so the user sees the spinner
                      // and the updated list after the network call lands.
                      e.stopPropagation();
                      if (!refreshAll.isPending) refreshAll.mutate();
                    }}
                    disabled={refreshAll.isPending}
                    title="Re-fetch every provider's /models endpoint and update the list"
                    data-testid="refresh-all-providers"
                    aria-label="Refresh provider models"
                    className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition disabled:opacity-50"
                  >
                    <RefreshCw
                      className={cn('size-3', refreshAll.isPending && 'animate-spin')}
                    />
                  </button>
                </div>
                <div className="shrink-0 px-2 pb-1 pt-1">
                  <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 transition-colors focus-within:border-primary/40">
                    <Search className="size-3 shrink-0 text-muted-foreground" />
                    <input
                      ref={searchRef}
                      type="text"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setFlyoutPos(null);
                      }}
                      onKeyDown={(e) => {
                        // Escape clears the search first — one layer per press.
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
                        onClick={() => {
                          setQuery('');
                          searchRef.current?.focus();
                        }}
                        aria-label="Clear model search"
                        className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </div>
                </div>
                <div
                  data-testid="models-panel-list"
                  className="py-1 overflow-y-auto min-h-0 flex-1 chat-scroll"
                >
                  {searching ? (
                    search.results.length > 0 ? (
                      <>
                        {search.results.map((m) => modelRow(m, true))}
                        {search.hidden > 0 && (
                          <div className="px-3 py-2 text-2xs text-muted-foreground">
                            {search.hidden} more match “{query.trim()}” — keep typing to narrow.
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="px-3 py-2 text-[0.8125rem] text-muted-foreground">
                        No model matches “{query.trim()}”.
                      </div>
                    )
                  ) : (
                    <>
                  {groups.length === 0 && (
                    <div className="px-3 py-2 text-[0.8125rem] text-muted-foreground">
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
                          'mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2 rounded-md px-2.5 py-[10px] text-left text-[0.9375rem] transition-colors',
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
                    </>
                  )}
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
                      className="mx-1.5 mb-1.5 w-[calc(100%-12px)] cursor-pointer rounded-md px-2.5 py-[10px] text-left text-[0.9375rem] text-foreground/90 hover:bg-muted/40"
                      data-testid="manage-models"
                    >
                      Manage models
                    </button>
                  </>
                )}
              </motion.div>
            )}
            {modelsOpen && flyoutPos && activeGroup && !searching && (
              <motion.div
                key="models-flyout"
                ref={flyoutRef}
                {...menuPanel}
                tabIndex={-1}
                onKeyDown={onPanelKeyDown}
                className="fixed z-50 bg-popover border border-border/60 rounded-xl shadow-2xl overflow-y-auto py-1 chat-scroll"
                style={{ top: flyoutPos.top, left: flyoutPos.left, width: FLYOUT_W, maxHeight: FLYOUT_H }}
                data-testid="provider-models-flyout"
              >
                {activeGroup.items.length > 0 ? (
                  activeGroup.items.map((m) => modelRow(m))
                ) : (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No models.</div>
                )}
              </motion.div>
            )}
            {effortOpen && effortPos && (
              <motion.div
                key="effort-panel"
                ref={effortPanelRef}
                {...menuPanel}
                tabIndex={-1}
                onKeyDown={onPanelKeyDown}
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
                          'flex w-full cursor-pointer items-center justify-between px-3 py-[7px] text-left text-[0.8125rem] transition-colors',
                          isSel
                            ? 'text-foreground'
                            : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                        )}
                      >
                        <span>{o.triggerLabel}</span>
                        {isSel && <Check className="size-3 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/40 px-3 py-2">
                  <span className="text-2xs text-muted-foreground">Extended thinking</span>
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
