/* ── Combined model + effort menu ─────────────────────────────────────── */
/* One pill trigger; one popover with a single-click model list.          */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Pin, RefreshCw, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { chipTrigger, menuPanel, menuItem } from '@/lib/motion';
import { providersApi } from '@/api/providers';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import type { ModelItem } from '../model-display';
import {
  formatContextWindow,
  getModelDisplayName,
  compareModelsRanked,
  modelDisplayParts,
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

export function shortModelName(model: ModelItem | null): string {
  if (!model) return 'Model';
  const name = modelDisplayParts(model.id || model.name || '').name || 'Model';
  // Keep chip label compact so long ids don't blow out the composer layout.
  return name.length > 28 ? `${name.slice(0, 26)}…` : name;
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
  openSignal,
}: {
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
  /** Incrementing counter — each change opens the menu (command palette). */
  openSignal?: number;
  promptHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  const closeAll = useCallback(() => {
    setOpen(false);
    setSearchQuery('');
  }, []);

  // Pin/unpin straight from the dropdown: resolve the provider entry behind
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
      const entry = provider?.models.find((mm) => mm.id === m.id);
      if (!provider) return;
      void providersApi
        .updateModel(provider.id, m.id, { pinned: !entry?.pinned })
        .then(() => refreshProviderCatalog(queryClient));
    },
    [providersList, queryClient],
  );

  // Position once on open, above the trigger, right-aligned.
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const el = triggerRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const width = 300;
      const height = 420;
      const top = Math.max(8, r.top - height - 8);
      const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
      setPos({ top, left });
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeAll();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      closeAll();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closeAll]);

  const grouped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? visibleModels.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            getModelDisplayName(m.id).toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q),
        )
      : visibleModels;
    return Object.entries(
      filtered.reduce(
        (acc, m) => {
          if (!acc[m.provider]) acc[m.provider] = [];
          acc[m.provider].push(m);
          return acc;
        },
        {} as Record<string, ModelItem[]>,
      ),
    ).map(([provider, list]) => ({
      provider,
      models: [...list].sort(compareModelsRanked),
    }));
  }, [visibleModels, searchQuery]);

  const effortOpt = EFFORT_OPTIONS.find((o) => o.value === effort) || EFFORT_OPTIONS[1];

  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        {...chipTrigger}
        onClick={() => (open ? closeAll() : setOpen(true))}
        className={cn(
          'relative inline-flex items-center gap-1 text-xs outline-none cursor-pointer h-8 max-w-[220px]',
          'text-muted-foreground hover:text-foreground transition-colors duration-200',
          'bg-muted/40 hover:bg-muted/60 rounded-full px-2.5 py-1',
        )}
        title={selected ? `${getModelDisplayName(selected.id || selected.name || '')} · ${effortOpt.triggerLabel}` : 'Select model'}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="min-w-0 truncate font-medium text-foreground">
          {shortModelName(selected)}
        </span>
        <span className="text-muted-foreground shrink-0">{effortOpt.triggerLabel}</span>
        <ChevronDown
          className={cn('size-3 shrink-0 opacity-60 transition-transform duration-200', open && 'rotate-180')}
        />
      </motion.button>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && pos && (
              <motion.div
                ref={panelRef}
                {...menuPanel}
                className="fixed z-50 bg-popover border border-border/60 rounded-xl shadow-2xl overflow-hidden"
                style={{ top: pos.top, left: pos.left, width: 300 }}
              >
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40">
                  <Search className="size-3.5 text-muted-foreground shrink-0" />
                  <input
                    ref={searchRef}
                    autoFocus
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search models"
                    className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                  />
                  {onRefresh && (
                    <button
                      type="button"
                      onClick={onRefresh}
                      title="Refresh models"
                      className="text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                    </button>
                  )}
                </div>
                <div className="max-h-[280px] overflow-y-auto py-1 chat-scroll">
                  {loading && visibleModels.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">Loading models…</div>
                  )}
                  {!loading && grouped.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">No models found.</div>
                  )}
                  {grouped.map((g) => (
                    <div key={g.provider}>
                      <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                        {g.provider}
                      </div>
                      {g.models.map((m) => {
                        const isSel = selected?.id === m.id && selected?.provider === m.provider;
                        return (
                          <div
                            key={`${m.provider}/${m.id}`}
                            {...menuItem}
                            className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50 cursor-pointer"
                            onClick={() => {
                              onSelect(m);
                              closeAll();
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate text-foreground">
                              {getModelDisplayName(m.id)}
                              {m.contextWindow ? (
                                <span className="ml-1.5 text-[10px] text-muted-foreground/70">
                                  {formatContextWindow(m.contextWindow)}
                                </span>
                              ) : null}
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
                      })}
                    </div>
                  ))}
                </div>
                <div className="border-t border-border/40 px-3 py-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">Effort</span>
                    <div className="flex items-center gap-1">
                      {EFFORT_OPTIONS.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          onClick={() => onEffortChange(o.value)}
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] cursor-pointer transition-colors',
                            effort === o.value
                              ? 'bg-primary/15 text-primary font-medium'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {o.triggerLabel}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">Extended thinking</span>
                    <ThinkingSwitch checked={thinkingEnabled} onChange={onThinkingChange} />
                  </div>
                  {onEditModels && (
                    <button
                      type="button"
                      onClick={() => {
                        closeAll();
                        onEditModels();
                      }}
                      className="w-full text-left text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      Manage models…
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
