/* ── Combined model + effort menu ─────────────────────────────────────── */
/* Reference-style picker: ONE combined dropdown. Provider names are group
 * headers, and each provider's models sit directly beneath it — no two-step
 * provider-then-flyout. The search field filters across every provider at
 * once (ids use `-`,`_`,`/`,`:` where a person types a space, so both sides
 * collapse the same way). The effort chip keeps its own small pane.
 *
 * The previous layout was a provider list whose hover revealed a SEPARATE
 * flyout card beside the panel. The reference shows provider-over-model in a
 * single view, which is both fewer moving parts and the layout the shared
 * groupModelsByProvider() helper already produces. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Gauge, Pin, RefreshCw, Search, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { chipTrigger, menuPanel, menuItem } from '@/lib/motion';
import { providersApi } from '@/api/providers';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import type { ModelItem } from '../model-display';
import { groupModelsByProvider } from '@/components/model/modelList';
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
 *  `useChatModels` sets `name = name || id`, so it can still be an identifier.
 *
 *  The provider prefix is stripped from `tag` when it duplicates the group
 *  header: "Sonnet 4 5 / anthropic" under an "Anthropic" header says the same
 *  thing twice. */
function modelRowLabel(model: ModelItem): { name: string; tag: string } {
  if (model.name && model.name !== model.id) return { name: model.name, tag: '' };
  const parts = modelDisplayParts(model.id || model.name);
  const tag = parts.tag.toLowerCase() === model.provider.toLowerCase() ? '' : parts.tag;
  return { name: parts.name, tag };
}

type PaneKind = 'models' | 'effort';

/** Composer-anchored panels: positioned by their BOTTOM edge (CSS bottom +
 *  clamped maxHeight) so short lists hug the chip instead of floating far
 *  above it. */
type PanelPos = { left: number; bottom: number; maxHeight: number };

const MODELS_PANEL_W = 280;
/** Ideal heights — panels render shorter than these when room is tight. */
const MODELS_PANEL_H = 440;
const EFFORT_PANEL_H = 150;
const EFFORT_PANEL_W = 264;

/** Gap between the panel's bottom edge and the trigger chip. */
const PANEL_GAP = 8;
/** Viewport margin kept clear above/below a panel. */
const VIEWPORT_MARGIN = 8;
/** Never shrink below this — the list scrolls internally instead. */
const MIN_PANEL_H = 96;
/** Ceiling on rendered search hits per provider, so a one-letter query cannot
 *  mount hundreds of rows; `hidden` tells the user what the cap dropped. */
const SEARCH_RESULT_CAP = 80;

function clampLeft(left: number, w: number): number {
  return Math.max(8, Math.min(left, window.innerWidth - w - 8));
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
  const [modelsPos, setModelsPos] = useState<PanelPos | null>(null);
  const [effortPos, setEffortPos] = useState<PanelPos | null>(null);
  // Model-name search, applied INSIDE groupModelsByProvider so a query filters
  // the grouped layout rather than replacing it with a separate flat list.
  const [query, setQuery] = useState('');
  // Which provider groups are collapsed. A click on a provider header folds
  // its models away (the reference lets you collapse a provider to scan the
  // rest); clicking again reopens. While searching, collapse is disabled —
  // filtering already narrows the list, and folding a match out of sight would
  // fight the query.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggleCollapsed = useCallback((provider: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const effortChipRef = useRef<HTMLButtonElement>(null);
  const modelsPanelRef = useRef<HTMLDivElement>(null);
  // The effort panel lives OUTSIDE modelsPanelRef in the portal — without its
  // own ref, mousedown on a row inside it would hit the outside-click handler
  // and close the menu before the click could land.
  const effortPanelRef = useRef<HTMLDivElement>(null);

  // ── Keyboard: roving focus through the open panel ──────────────────────
  // Every row here was mouse-only: ArrowDown did nothing and Tab walked out
  // of the menu entirely, which made the highest-frequency picker in the
  // composer unusable without a pointer. With provider headers inline, focus
  // simply walks the painted rows in order — provider header, its models, the
  // next provider — so there is no second panel to coordinate.
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
      const panel = pane === 'models' ? modelsPanelRef.current : effortPanelRef.current;
      panel?.focus();
      return;
    }
    if (!hasOpenedRef.current) return;
    hasOpenedRef.current = false;
    const chip = pane === 'effort' ? effortChipRef.current : modelChipRef.current;
    chip?.focus();
  }, [pane, modelsPos, effortPos]);

  useEffect(() => {
    if (openSignal) setPane('models');
  }, [openSignal]);

  const closeAll = useCallback(() => {
    setPane(null);
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
  // composer, the settings dropdown and the visibility modal. The query is
  // passed INTO the helper, so searching filters the grouped layout (a
  // provider header disappears only when none of its models match) rather
  // than flattening it into a separate result list.
  const groups = useMemo(() => groupModelsByProvider(visibleModels, query), [visibleModels, query]);
  const searching = query.trim().length > 0;
  const totalMatches = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);

  // Cap the FLATTENED match count while SEARCHING, so a one-letter query cannot
  // mount hundreds of rows across every provider. `capped` reports what the cap
  // held back. Unfiltered (no query) lists are never capped — the full catalog
  // is the honest default, and the panel scrolls.
  const cappedGroups = useMemo(() => {
    if (!searching || totalMatches <= SEARCH_RESULT_CAP) return groups;
    let remaining = SEARCH_RESULT_CAP;
    const out: typeof groups = [];
    for (const g of groups) {
      if (remaining <= 0) break;
      const take = g.items.slice(0, remaining);
      remaining -= take.length;
      out.push({ ...g, items: take });
    }
    return out;
  }, [groups, searching, totalMatches]);
  const cappedCount = Math.max(0, totalMatches - SEARCH_RESULT_CAP);

  // Position the panel once on open (above the chip, like the reference).
  useEffect(() => {
    if (!pane) {
      setModelsPos(null);
      setEffortPos(null);
      setQuery('');
      setCollapsed(new Set());
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
                  {groups.length === 0 && (
                    <div className="px-3 py-2 text-[0.8125rem] text-muted-foreground">
                      {loading
                        ? 'Loading…'
                        : searching
                          ? `No model matches “${query.trim()}”.`
                          : 'No providers.'}
                    </div>
                  )}
                  {cappedGroups.map((g) => {
                    const isCur = g.provider === selected?.provider;
                    const isCollapsed = collapsed.has(g.provider);
                    return (
                      <div key={`g_${g.provider}`} data-testid={`provider-group-${g.provider}`}>
                        {/* Provider group header — models sit directly beneath,
                            matching the reference's provider-over-model view.
                            Clicking the header collapses/expands that provider's
                            models so a long catalog can be scanned by provider. */}
                        <button
                          type="button"
                          onClick={() => toggleCollapsed(g.provider)}
                          aria-expanded={!isCollapsed}
                          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${g.provider}`}
                          data-testid={`provider-header-${g.provider}`}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 pt-2 pb-1 text-left text-2xs font-semibold uppercase tracking-wide transition-colors',
                            isCur ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground',
                          )}
                        >
                          {isCur && <Check className="size-2.5 shrink-0" />}
                          <ChevronDown
                            className={cn(
                              'size-3 shrink-0 transition-transform',
                              isCollapsed && '-rotate-90',
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">{g.provider}</span>
                          <span className="shrink-0 font-normal tabular-nums text-muted-foreground/50">
                            {g.items.length}
                          </span>
                        </button>
                        {!isCollapsed && g.items.map((m) => modelRow(m))}
                      </div>
                    );
                  })}
                  {cappedCount > 0 && (
                    <div className="px-3 py-2 text-2xs text-muted-foreground">
                      Showing the first {SEARCH_RESULT_CAP} of {totalMatches} matches — keep
                      typing to narrow.
                    </div>
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
