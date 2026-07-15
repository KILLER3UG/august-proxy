/* ── Composer controls (extracted from ChatThread) ───────────────────── */
/* Model picker, effort dropdown, tool icon button.                       */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import type { ModelItem } from './model-display';
import {
  modelDisplayParts,
  formatContextWindow,
  getModelDisplayName,
} from './model-display';

export function ToolBtn({ Icon, label, onClick, className, buttonRef }: { Icon: LucideIcon; label: string; onClick?: () => void; className?: string; buttonRef?: React.RefObject<HTMLButtonElement | null> }) {
  return (
    <button
      ref={buttonRef ?? undefined}
      onClick={onClick}
      className={cn('h-8 w-8 p-0 rounded-lg hover:bg-muted hover:text-foreground transition text-muted-foreground', className)}
      title={label}
      aria-label={label}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/* ── Custom Model Dropdown ────────────────────────────────────────── */
/* Renders the trigger inline and the dropdown panel via React portal to
 * `document.body` with `position: fixed`. This escapes the
 * `overflow: hidden` chain on the chat-thread column and the chat-layout
 * main column — without this, the dropdown was clipped at the chat-thread
 * boundary when opened in the empty/centered composer state. */

export function ModelDropdown({ models: _models, visibleModels, loading, selected, onSelect, onRefresh, onEditModels }: {
  models: ModelItem[];
  visibleModels: ModelItem[];
  loading?: boolean;
  selected: ModelItem | null;
  onSelect: (m: ModelItem | null) => void;
  onRefresh?: () => void;
  onEditModels?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollEnd, setScrollEnd] = useState(false);
  // Position of the dropdown panel in viewport coordinates. Recomputed
  // each time the dropdown opens and on scroll/resize while open.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const computePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const width = Math.max(240, Math.min(320, r.width + 80));
    // Estimate the panel height so the initial position sits ABOVE the
    // trigger (panel's bottom edge near r.top), not on top of it. Refined
    // to the real height on the next frame once the panel has mounted.
    const estHeight = 320;
    const desiredTop = r.top - estHeight - 4;
    const top = Math.max(8, desiredTop);
    const right = Math.max(8, window.innerWidth - r.right);
    return { top, right, width };
  }, []);

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    const panel = listRef.current?.parentElement?.parentElement;
    if (!el || !panel) return;
    const r = el.getBoundingClientRect();
    const panelHeight = panel.offsetHeight || 320;
    const desiredTop = r.top - panelHeight - 4;
    const top = Math.max(8, desiredTop);
    const right = Math.max(8, window.innerWidth - r.right);
    setPos({ top, right });
  }, []);

  // Close on outside click. Use the triggerRef as the inclusion point.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (listRef.current?.parentElement?.parentElement?.contains(target)) return;
      setOpen(false);
      setSearchQuery('');
      setExpandedProviders(new Set());
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setSearchQuery('');
        setExpandedProviders(new Set());
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Recompute position on scroll/resize while open (handles the composer
  // being in a scrollable column or the window being resized).
  useEffect(() => {
    if (!open) return;
    // Set a viewport-relative position from the trigger alone, *before* the
    // panel is mounted. Without this, the panel never renders because it
    // gates on `pos` being truthy and `updatePosition` needs the panel
    // already in the DOM to measure its height.
    const initial = computePos();
    if (initial) setPos(initial);
    // Defer one frame so the panel mounts, then refine using its real height.
    requestAnimationFrame(() => updatePosition());
    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, computePos, updatePosition]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      // Defer one frame so the panel is mounted before we measure.
      requestAnimationFrame(() => {
        updatePosition();
        setTimeout(() => searchRef.current?.focus(), 0);
      });
    } else {
      setSearchQuery('');
      setExpandedProviders(new Set());
    }
  }, [open, updatePosition]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setScrollEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  };

  const filtered = searchQuery.trim()
    ? visibleModels.filter(m =>
        m.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        getModelDisplayName(m.id).toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.provider.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : visibleModels;

  const grouped = Object.entries(
    filtered.reduce((acc, m) => {
      if (!acc[m.provider]) acc[m.provider] = [];
      acc[m.provider].push(m);
      return acc;
    }, {} as Record<string, ModelItem[]>)
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
    return { provider, models: sorted, visible, isExpanded, total: sorted.length, showCollapse };
  });

  const dropdownContent = (
    <AnimatePresence>
      {open && pos && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.97 }}
          transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="fixed z-50 min-w-[240px] max-w-[320px] bg-popover rounded-lg shadow-2xl overflow-hidden origin-bottom-right"
          style={{ top: pos.top, right: pos.right }}
        >
          {/* Search bar */}
          <div className="px-1.5 pt-1.5 pb-0.5 bg-popover">
            <div className="flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1">
              <svg className="size-2.5 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search…"
                className="bg-transparent text-sm font-mono outline-none w-full placeholder:text-muted-foreground/50 text-foreground py-0.5"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="p-0.5 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition"
                >
                  <svg className="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
              {onRefresh && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void onRefresh();
                  }}
                  className={cn(
                    "p-0.5 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition",
                    loading && "animate-spin"
                  )}
                  title="Refresh models list"
                  disabled={loading}
                >
                  <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="relative">
            {/* Top fade indicator */}
            <div className={cn(
              'absolute top-0 left-0 right-0 h-5 z-10 pointer-events-none transition-opacity',
              'bg-gradient-to-b from-popover to-transparent',
              scrollTop > 4 ? 'opacity-100' : 'opacity-0'
            )} />
            {/* Bottom fade indicator */}
            <div className={cn(
              'absolute bottom-0 left-0 right-0 h-5 z-10 pointer-events-none transition-opacity',
              'bg-gradient-to-t from-popover to-transparent',
              scrollEnd ? 'opacity-0' : 'opacity-100'
            )} />

            <div
              ref={listRef}
              onScroll={onScroll}
              className="model-dropdown-list max-h-[240px] overflow-x-hidden overflow-y-auto py-0.5"
            >
              {loading && grouped.length === 0 ? (
                <div className="px-2 py-1 space-y-1">
                  <div className="skeleton-row h-4 w-20 rounded my-1" />
                  <div className="skeleton-row h-7 w-full rounded" />
                  <div className="skeleton-row h-7 w-full rounded" />
                  <div className="skeleton-row h-7 w-full rounded" />
                  <div className="skeleton-row h-4 w-24 rounded my-1" />
                  <div className="skeleton-row h-7 w-full rounded" />
                  <div className="skeleton-row h-7 w-full rounded" />
                </div>
              ) : grouped.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {searchQuery.trim() ? `No results for "${searchQuery.trim()}"` : 'no models loaded'}
                </div>
              ) : (
                grouped.map(({ provider, visible, isExpanded, total, showCollapse }) => (
                  <div key={provider}>
                    <div className="px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold sticky top-0 bg-popover/95 backdrop-blur z-20 flex justify-between items-center">
                      <span>{provider}</span>
                      <span className="text-[10px] lowercase font-mono text-muted-foreground/60">({total})</span>
                    </div>
                    {visible.map(m => {
                      const { name, tag } = modelDisplayParts(m.id);
                      return (
                        <button
                          key={m.id}
                          onClick={() => { onSelect(m); setOpen(false); }}
                          className={cn(
                            'w-full text-left px-2.5 py-1.5 text-sm transition-all duration-150 flex items-center gap-2 rounded-md mx-1',
                            selected?.id === m.id
                              ? 'text-primary bg-primary/10 font-semibold'
                              : 'text-foreground/80 hover:bg-white/5 hover:text-foreground'
                          )}
                        >
                          <span className="truncate flex-1 font-sans">
                            {name}
                            {tag && (
                              <span className="ml-1.5 text-[10px] text-muted-foreground/50 font-normal">{tag}</span>
                            )}
                          </span>
                          <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
                            {formatContextWindow(m.contextWindow)}
                          </span>
                        </button>
                      );
                    })}
                    {showCollapse && (
                      <button
                        onClick={() => {
                          setExpandedProviders(prev => {
                            const next = new Set(prev);
                            if (isExpanded) next.delete(provider);
                            else next.add(provider);
                            return next;
                          });
                        }}
                        className="w-full text-left px-2.5 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/5 transition"
                      >
                        {isExpanded ? '▲ Show less' : '▼ Show ' + (total - 5) + ' more'}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Edit models link */}
            {onEditModels && (
              <div className="px-2 py-1.5 border-t border-border/20">
                <button
                  onClick={() => { onEditModels(); setOpen(false); }}
                  className="w-full text-left px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-white/5 rounded-md transition"
                >
                  Edit models
                </button>
              </div>
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
        onClick={() => setOpen((v: boolean) => !v)}
        className={cn(
          'relative flex items-center gap-1.5 text-xs font-sans outline-none cursor-pointer shrink-0 h-8',
          'text-muted-foreground hover:text-foreground transition-all duration-200',
          'bg-muted/30 hover:bg-muted/50 rounded-md px-2 py-1',
        )}
        title={selected ? getModelDisplayName(selected.id || selected.name || '') : 'Select model'}
      >
        {selected && (
          <span className="text-[10px] bg-primary/10 text-primary px-1 py-0.5 rounded uppercase font-semibold tracking-wider scale-90 origin-left shrink-0">
            {selected.provider === 'openai-api' ? 'openai' : selected.provider}
          </span>
        )}
        <span className="truncate max-w-[140px] font-medium text-foreground transition-all duration-200">{selected ? modelDisplayParts(selected.id || selected.name || '').name : 'model'}</span>
        <svg className={cn("size-3 shrink-0 opacity-60 ml-0.5 transition-transform duration-200", open && "rotate-180")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {typeof document !== 'undefined' && createPortal(dropdownContent, document.body)}
    </>
  );
}

/* ── Custom Effort Dropdown ──────────────────────────────────────── */
export function EffortDropdown({ value, onChange }: {
  value: 'low' | 'medium' | 'high' | 'max';
  onChange: (v: 'low' | 'medium' | 'high' | 'max') => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const options: { value: 'low' | 'medium' | 'high' | 'max'; label: string; desc: string }[] = [
    { value: 'low', label: 'Low', desc: 'Short thinking, fast response' },
    { value: 'medium', label: 'Medium', desc: 'Balanced thinking & speed' },
    { value: 'high', label: 'High', desc: 'Thorough reasoning' },
    { value: 'max', label: 'Max', desc: 'Full depth, maximum reasoning' },
  ];

  const currentOpt = options.find(o => o.value === value) || options[1];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 text-xs outline-none cursor-pointer h-8',
          'text-muted-foreground hover:text-foreground transition-all duration-200',
          'bg-muted/30 hover:bg-muted/50 rounded-md px-2 py-1',
        )}
        title="Thinking Effort"
      >
<span className="text-sm font-medium text-foreground transition-all duration-200">
          {currentOpt.label}
        </span>
        <svg className={cn("size-2.5 shrink-0 opacity-60 transition-transform duration-200", open && "rotate-180")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="absolute bottom-full mb-1.5 right-0 z-50 min-w-[200px] bg-popover rounded-lg shadow-2xl py-1 origin-bottom-right"
          >
            <div className="px-2.5 py-1 text-[10px] text-muted-foreground/50 uppercase tracking-widest font-semibold mb-0.5">
              Reasoning Effort
            </div>
            {options.map(opt => (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={cn(
                  'w-full text-left px-2.5 py-1.5 text-[13px] transition-all duration-150 flex flex-col gap-0.5 rounded-md mx-1',
                  value === opt.value
                    ? 'text-primary bg-primary/10 font-semibold'
                    : 'text-foreground/80 hover:bg-white/5 hover:text-foreground'
                )}
              >
                <span className="font-sans font-medium">{opt.label}</span>
                <span className="text-[12px] text-muted-foreground/50">{opt.desc}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

