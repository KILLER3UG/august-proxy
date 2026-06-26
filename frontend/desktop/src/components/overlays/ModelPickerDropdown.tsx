/* ── ModelPickerDropdown — model picker with search + groups ────────── */
/* Visually identical to the chat ModelDropdown, minus collapse toggles.  */
/* Portal-based positioning to escape overflow clipping.                  */
/*                                                                        */
/* Props:                                                                 */
/*   models    – AggregatedModel[] from getAggregatedModels()             */
/*   value     – currently selected model id (empty string = none)        */
/*   onChange  – (modelId, provider) when user picks a model              */
/*   disabled  – disables the trigger button                              */
/* ──────────────────────────────────────────────────────────────────────── */

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { modelDisplayParts, getModelDisplayName, formatContextWindow } from '@/sections/chat/ChatThread';
import type { AggregatedModel } from '@/api/api-client';

interface ModelPickerDropdownProps {
  models: AggregatedModel[];
  value: string;
  onChange: (modelId: string, provider: string) => void;
  disabled?: boolean;
}

export function ModelPickerDropdown({ models, value, onChange, disabled }: ModelPickerDropdownProps) {
  const [open, setOpen] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollEnd, setScrollEnd] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const selected = value ? models.find((m) => m.id === value) ?? null : null;

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    const panel = listRef.current?.parentElement?.parentElement;
    if (!el || !panel) return;
    const r = el.getBoundingClientRect();
    const panelHeight = panel.offsetHeight || 400;
    const panelWidth = panel.offsetWidth || 440;
    // Default: open below the trigger. Flip above if not enough room.
    let top = r.bottom + 4;
    if (top + panelHeight > window.innerHeight - 8) {
      top = r.top - panelHeight - 4;
    }
    top = Math.max(8, top);
    const maxLeft = window.innerWidth - panelWidth - 8;
    const left = Math.max(8, Math.min(r.left, maxLeft));
    setPos({ top, left });
  }, []);

  // Estimate position before the panel is in the DOM (no panel measurement).
  const computeInitialPos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const estHeight = 400;
    const estWidth = 440;
    // Default: open below the trigger. Flip above if not enough room.
    let top = r.bottom + 4;
    if (top + estHeight > window.innerHeight - 8) {
      top = r.top - estHeight - 4;
    }
    top = Math.max(8, top);
    const maxLeft = window.innerWidth - estWidth - 8;
    const left = Math.max(8, Math.min(r.left, maxLeft));
    setPos({ top, left });
  }, []);

  // Close on outside click
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

  // Close on Escape
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

  // Set initial position immediately so the panel can render, then refine
  // with the actual panel height once it's in the DOM.
  useEffect(() => {
    if (!open) return;
    computeInitialPos(); // synchronous — unblocks the {open && pos && ( gate
    const id = requestAnimationFrame(() => updatePosition());
    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, computeInitialPos, updatePosition]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 0);
    } else {
      setSearchQuery('');
      setExpandedProviders(new Set());
    }
  }, [open]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setScrollEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  };

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
          className="fixed z-50 min-w-[280px] max-w-[440px] bg-popover rounded-lg shadow-2xl overflow-hidden origin-top-left"
          style={{ top: pos.top, left: pos.left }}
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
              className="model-dropdown-list max-h-[360px] overflow-x-hidden overflow-y-auto py-0.5"
            >
              {grouped.length === 0 ? (
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
                          onClick={() => {
                            onChange(m.id, m.provider);
                            setOpen(false);
                          }}
                          className={cn(
                            'w-full text-left px-2.5 py-1.5 text-sm transition-all duration-150 flex items-center gap-2 rounded-md mx-1',
                            value === m.id
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
        title={selected ? getModelDisplayName(selected.id) : 'Select model'}
        disabled={disabled}
      >
        {selected ? (
          <>
            <span className="text-[10px] bg-primary/10 text-primary px-1 py-0.5 rounded uppercase font-semibold tracking-wider scale-90 origin-left shrink-0 leading-none">
              {selected.provider === 'openai-api' ? 'openai' : selected.provider}
            </span>
            <span className="truncate max-w-[140px] font-medium text-foreground transition-all duration-200 leading-none">
              {modelDisplayParts(selected.id || selected.name || '').name}
            </span>
          </>
        ) : (
          <span className="truncate text-muted-foreground leading-none">Select model</span>
        )}
        <svg
          className={cn(
            "size-3 shrink-0 opacity-60 ml-0.5 transition-transform duration-200",
            open && "rotate-180",
          )}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {typeof document !== 'undefined' && createPortal(dropdownContent, document.body)}
    </>
  );
}
