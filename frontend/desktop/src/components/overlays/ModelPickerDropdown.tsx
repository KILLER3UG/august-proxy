/* ── ModelPickerDropdown — model picker with search + groups ────────── */
/* Visually identical to the chat ModelDropdown, minus collapse toggles.  */
/* Portal-based positioning to escape overflow clipping.                  */
/*                                                                        */
/* Props:                                                                 */
/*   models       – AggregatedModel[] from getAggregatedModels()             */
/*   value        – currently selected model id (empty string = none)        */
/*   modelProvider – the gateway `value` belongs to, when the caller knows  */
/*                   one. Ids repeat across gateways, so without it the     */
/*                   trigger can badge the wrong provider and two rows tick. */
/*   onChange     – (modelId, provider) when user picks a model              */
/*   disabled     – disables the trigger button                              */
/* ──────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { modelDisplayParts, getModelDisplayName, formatContextWindow } from '@/sections/chat/ChatThread';
import { compareModelsRanked, findCatalogModel } from '@/sections/chat/model-display';
import type { AggregatedModel } from '@/api/api-client';

/** One source for the panel geometry. These were four loose numbers (400/440
 *  estimates in two near-duplicate functions, 280/440/360 in the markup), which
 *  is how a panel's estimate and its actual size drift apart and the flip-above
 *  logic misfires on a tall list. */
const PANEL = { minW: 280, maxW: 440, maxH: 360, edge: 8, gap: 4 } as const;

/** A provider shows this many models before "show more" appears. */
const GROUP_PREVIEW = 5;

/** A provider's own id is a config key, not a label. This was an inline
 *  ternary in the trigger; one function so every surface can say the same
 *  thing about `openai-api`. */
function providerBadge(provider: string): string {
  return provider.replace(/-api$/, '');
}

interface ModelPickerDropdownProps {
  models: AggregatedModel[];
  value: string;
  modelProvider?: string;
  onChange: (modelId: string, provider: string) => void;
  disabled?: boolean;
}

export function ModelPickerDropdown({
  models,
  value,
  modelProvider,
  onChange,
  disabled,
}: ModelPickerDropdownProps) {
  const [open, setOpen] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  // Keyboard cursor over the flattened, in-order visible rows. The list is a
  // listbox, so this is what aria-activedescendant points at.
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const selected = value ? findCatalogModel(models, value, modelProvider) ?? null : null;
  // Without a gateway to go on, every row sharing the id highlights — which is
  // what an id-only caller (fleet, reflection) genuinely stores.
  const isSelected = (m: AggregatedModel) =>
    m.id === value && (!modelProvider || m.provider === modelProvider);

  /** Place the panel beside the trigger, flipping above when it would run off
   *  the bottom. `size` is the measured panel once it is in the DOM and the
   *  PANEL estimate before, which is the only difference between the two
   *  functions this replaces. */
  const place = useCallback((size?: { h: number; w: number }) => {
    const el = triggerRef.current;
    if (!el) return;
    const h = size?.h ?? PANEL.maxH;
    const w = size?.w ?? PANEL.maxW;
    const r = el.getBoundingClientRect();
    let top = r.bottom + PANEL.gap;
    if (top + h > window.innerHeight - PANEL.edge) top = r.top - h - PANEL.gap;
    top = Math.max(PANEL.edge, top);
    const maxLeft = window.innerWidth - w - PANEL.edge;
    setPos({ top, left: Math.max(PANEL.edge, Math.min(r.left, maxLeft)) });
  }, []);

  // One reset path. Escape, outside click and choosing a model each cleared a
  // different subset of this state, which is how a reopen could show the last
  // query with no rows filtered by it.
  const close = useCallback(() => {
    setOpen(false);
    setSearchQuery('');
    setExpandedProviders(new Set());
    setActive(0);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (listRef.current?.parentElement?.parentElement?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  // Position synchronously on open so the panel is never painted at 0,0, then
  // refine with the real panel height once it has one.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    const el = listRef.current?.parentElement?.parentElement;
    const id = requestAnimationFrame(() =>
      place(el ? { h: el.offsetHeight, w: el.offsetWidth } : undefined),
    );
    const onScroll = () => place();
    const onResize = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, place]);

  // Focus the search field when the panel mounts. A timeout worked but raced the
  // first paint, so a fast keystroke could land before the input had focus.
  useLayoutEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const filtered = searchQuery.trim()
    ? models.filter(m =>
        m.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        getModelDisplayName(m.id).toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.provider.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : models;

  const grouped = Object.entries(
    filtered.reduce((acc, m) => {
      if (!acc[m.provider]) acc[m.provider] = [];
      acc[m.provider].push(m);
      return acc;
    }, {} as Record<string, AggregatedModel[]>)
  ).map(([provider, list]) => {
    // The shared ranking — pinned, then free, then name. Sorting by isFree and
    // name here instead meant `pinned` was read by nothing in this component, so
    // pinning a model changed nothing in the settings lists while it did in the
    // composer, which is the one job compareModelsRanked exists to do.
    const sorted = [...list].sort(compareModelsRanked);
    const isSearching = searchQuery.trim().length > 0;
    const isExpanded = expandedProviders.has(provider);
    const visible = isSearching || isExpanded ? sorted : sorted.slice(0, GROUP_PREVIEW);
    const showCollapse = sorted.length > GROUP_PREVIEW && !isSearching;
    return { provider, models: sorted, visible, isExpanded, total: sorted.length, showCollapse };
  });

  // The rows in the order they are painted. Keyboard navigation has to follow
  // the same flattened sequence the eye follows, so it is derived from `grouped`
  // rather than re-walking the tree in a key handler.
  const rows = grouped.flatMap((g) => g.visible.map((m) => ({ ...m, provider: g.provider })));

  // Where each group starts in that flattened order, for row ids and the cursor.
  const groupOffsets: number[] = [];
  grouped.reduce((acc, g) => {
    groupOffsets.push(acc);
    return acc + g.visible.length;
  }, 0);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        triggerRef.current?.focus();
        return;
      }
      if (!rows.length) return;
      const last = rows.length - 1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, last));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActive(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActive(last);
      } else if (e.key === 'Enter') {
        // The search input is focused on open, so Enter has to be handled here
        // rather than on a button: without this, a keyboard user can filter the
        // list but can never choose from it.
        e.preventDefault();
        const pick = rows[active] ?? rows[0];
        if (pick) {
          onChange(pick.id, pick.provider);
          close();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, rows, active, onChange, close]);

  // Keep the highlighted row in view as the cursor moves past the fold.
  // Optional call: jsdom has no scrollIntoView, and this must not be a crash in
  // a test environment for a nicety that only exists in a real scroller.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`model-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const dropdownContent = (
    <AnimatePresence>
      {open && pos && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.97 }}
          transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="fixed z-50 bg-popover rounded-lg shadow-2xl overflow-hidden origin-top-left"
          style={{
            top: pos.top,
            left: pos.left,
            minWidth: PANEL.minW,
            maxWidth: PANEL.maxW,
          }}
        >
          {/* Search bar */}
          <div className="px-1.5 pt-1.5 pb-0.5 bg-popover">
            <div className="flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1">
              <Search className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              <input
                ref={searchRef}
                type="text"
                role="combobox"
                aria-expanded={open}
                aria-controls="model-picker-listbox"
                aria-label="Search models"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search models"
                className="bg-transparent text-sm outline-none w-full placeholder:text-muted-foreground/50 text-foreground py-0.5"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear model search"
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground transition"
                >
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </div>
          </div>

          <div className="relative">
            <div
              ref={listRef}
              id="model-picker-listbox"
              role="listbox"
              aria-label="Models"
              tabIndex={-1}
              aria-activedescendant={rows[active] ? `model-option-${active}` : undefined}
              className="model-dropdown-list overflow-x-hidden overflow-y-auto py-0.5"
              style={{
                maxHeight: PANEL.maxH,
                // The two absolutely-positioned gradient fades this replaces each
                // cost a state update per scroll event; the mask clips the same
                // edges with no listener and no re-render.
                maskImage:
                  'linear-gradient(to bottom, transparent 0, black 12px, black calc(100% - 12px), transparent 100%)',
              }}
            >
              {grouped.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {searchQuery.trim() ? `No models match “${searchQuery.trim()}”` : 'No models configured yet'}
                </div>
              ) : (
                grouped.map((g, gi) => {
                  const { provider, visible, isExpanded, total, showCollapse } = g;
                  // Absolute position within the flattened keyboard order, so a
                  // group header between rows cannot desync the cursor from what
                  // is highlighted.
                  const offset = groupOffsets[gi] ?? 0;
                  return (
                  <div key={provider}>
                    <div className="px-2 py-1 text-2xs uppercase tracking-widest text-muted-foreground/70 font-semibold sticky top-0 z-20 flex justify-between items-center bg-popover">
                      <span>{provider}</span>
                      <span className="text-2xs tabular-nums text-muted-foreground/60">{total}</span>
                    </div>
                    {visible.map((m, vi) => {
                      const { name, tag } = modelDisplayParts(m.id);
                      const i = offset + vi;
                      // The provider is already the sticky group header, so the
                      // id-derived tag repeats it: rows read
                      // "Sonnet 5anthropic—" — three runs of text with no
                      // separator. Show the tag only when it says something the
                      // header does not (a variant like "openai:latest").
                      const tagAddsInfo = Boolean(tag) && tag !== provider && !tag.startsWith(`${provider}:`);
                      const isCurrent = value === m.id;
                      return (
                        <button
                          key={m.id}
                          id={`model-option-${i}`}
                          type="button"
                          role="option"
                          aria-selected={isCurrent}
                          onClick={() => {
                            onChange(m.id, m.provider);
                            close();
                          }}
                          onMouseEnter={() => setActive(i)}
                          className={cn(
                            'w-full text-left px-2.5 py-1.5 text-sm transition-colors duration-150 flex items-center gap-2 rounded-md mx-1',
                            isSelected(m)
                              ? 'text-primary bg-primary/10 font-semibold'
                              : 'text-foreground/80 hover:text-foreground',
                            // The keyboard cursor is a separate signal from the
                            // selected model, so it must not be the same tint.
                            active === i && !isCurrent && 'bg-accent text-accent-foreground',
                          )}
                        >
                          <span className="truncate flex-1">
                            {name}
                            {tagAddsInfo && (
                              <span className="ml-1.5 text-2xs text-muted-foreground/50 font-normal">{tag}</span>
                            )}
                          </span>
                          {m.contextWindow ? (
                            <span className="text-2xs text-muted-foreground/60 shrink-0 tabular-nums">
                              {formatContextWindow(m.contextWindow)}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                    {showCollapse && (
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedProviders(prev => {
                            const next = new Set(prev);
                            if (isExpanded) next.delete(provider);
                            else next.add(provider);
                            return next;
                          });
                        }}
                        className="w-full text-left px-2.5 py-1 text-2xs text-muted-foreground flex items-center gap-1 hover:text-foreground transition"
                      >
                        {isExpanded ? (
                          <ChevronUp className="size-3" aria-hidden />
                        ) : (
                          <ChevronDown className="size-3" aria-hidden />
                        )}
                        {isExpanded ? 'Show less' : `Show ${total - GROUP_PREVIEW} more`}
                      </button>
                    )}
                  </div>
                  );
                })
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => !disabled && setOpen((v: boolean) => !v)}
        className={cn(
          'relative flex items-center gap-1.5 text-xs font-sans outline-none cursor-pointer w-full h-8',
          'text-muted-foreground hover:text-foreground transition-all duration-200',
          'bg-muted/30 hover:bg-muted/50 rounded-md px-2 py-1',
          disabled && 'opacity-60 cursor-not-allowed',
        )}
        // aria-label, not title: a native tooltip is not keyboard-reachable and
        // cannot be styled, and the repo's rule is no native title=. The full
        // model name lived only in that tooltip, so it moves into the label.
        aria-label={selected ? `Model: ${getModelDisplayName(selected.id)}` : 'Select model'}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
      >
        {selected ? (
          <>
            <span className="text-2xs bg-primary/10 text-primary px-1 py-0.5 rounded uppercase font-semibold tracking-wider scale-90 origin-left shrink-0 leading-none">
              {providerBadge(selected.provider)}
            </span>
            <span className="truncate min-w-0 font-medium text-foreground leading-none">
              {modelDisplayParts(selected.id || selected.name || '').name}
            </span>
          </>
        ) : (
          <span className="truncate text-muted-foreground leading-none">Select model</span>
        )}
        <ChevronDown
          className={cn(
            "size-3 shrink-0 opacity-60 ml-0.5 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {typeof document !== 'undefined' && createPortal(dropdownContent, document.body)}
    </>
  );
}
