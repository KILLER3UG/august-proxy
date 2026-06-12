import { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Plus, Search, Check } from 'lucide-react';
import { modelDisplayParts, getModelDisplayName } from '@/sections/chat/ChatThread';
import { cn } from '@/lib/utils';

interface ModelItem {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  isFree?: boolean;
  supportsReasoning?: boolean;
  supportsThinking?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  models: ModelItem[];
  loading: boolean;
  hiddenModels: Set<string>;
  onToggleModel: (modelId: string) => void;
  onNavigate: (path: string) => void;
  onRefreshModels?: () => void;
}

const STORAGE_KEY = 'august-hidden-models';

export function loadHiddenModels(): Set<string> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return new Set(JSON.parse(saved));
  } catch {}
  return new Set();
}

export function saveHiddenModels(hidden: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden]));
}

export function ModelVisibilityModal({ open, onClose, models, loading, hiddenModels, onToggleModel, onNavigate, onRefreshModels }: Props) {
  const [search, setSearch] = useState('');
  const [internalLoading, setInternalLoading] = useState(false);

  useEffect(() => {
    if (open && models.length === 0) {
      setInternalLoading(true);
      onRefreshModels?.();
    }
  }, [open, models.length]);

  useEffect(() => {
    if (models.length > 0) setInternalLoading(false);
  }, [models.length]);

  const isLoading = loading || internalLoading;

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? models.filter(m =>
          m.id.toLowerCase().includes(q) ||
          getModelDisplayName(m.id).toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q)
        )
      : models;

    const groups: Record<string, ModelItem[]> = {};
    filtered.forEach(m => {
      if (!groups[m.provider]) groups[m.provider] = [];
      groups[m.provider].push(m);
    });

    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [models, search]);

  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="fixed left-1/2 top-[15%] z-50 -translate-x-1/2 w-[420px] h-[500px] bg-popover rounded-xl shadow-2xl flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
              <h2 className="text-sm font-semibold text-foreground">Edit Models</h2>
              <button onClick={onClose} className="p-1 hover:bg-white/10 rounded text-muted-foreground hover:text-foreground transition">
                <X className="size-4" />
              </button>
            </div>

            {/* Search */}
            <div className="px-4 py-2 border-b border-border/20">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/50" />
                <input
                  autoFocus
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search models..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted/30 rounded-md border-none outline-none text-foreground placeholder:text-muted-foreground/50"
                />
              </div>
            </div>

            {/* Model list */}
            <div className="flex-1 overflow-y-auto px-2 py-2 min-h-0">
              {isLoading && models.length === 0 ? (
                <div className="space-y-2 px-2 py-3">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2.5">
                      <div className="size-4 rounded bg-muted/30 animate-pulse" />
                      <div className={cn("h-3 rounded bg-muted/30 animate-pulse", i % 3 === 0 ? 'w-3/4' : i % 3 === 1 ? 'w-1/2' : 'w-2/3')} />
                    </div>
                  ))}
                </div>
              ) : grouped.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  {search ? 'No models match your search' : 'No models available'}
                </div>
              ) : (
                grouped.map(([provider, providerModels]) => (
                  <div key={provider} className="mb-3">
                    <div className="px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground/50 font-semibold">
                      {provider}
                    </div>
                    {providerModels.map(m => {
                      const { name, tag } = modelDisplayParts(m.id);
                      const isVisible = !hiddenModels.has(m.id);
                      return (
                        <button
                          key={m.id}
                          onClick={() => onToggleModel(m.id)}
                          className={cn(
                            'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left transition',
                            isVisible ? 'hover:bg-white/5' : 'opacity-40 hover:opacity-60 hover:bg-white/5'
                          )}
                        >
                          <span className={cn(
                            'size-4 rounded flex items-center justify-center shrink-0 border transition-colors',
                            isVisible
                              ? 'bg-primary border-primary text-primary-foreground'
                              : 'border-muted-foreground/30 bg-transparent'
                          )}>
                            {isVisible && <Check className="size-2.5" />}
                          </span>
                          <span className="truncate flex-1 text-xs font-sans">
                            {name}
                            {tag && <span className="ml-1 text-muted-foreground/50 text-[10px]">{tag}</span>}
                          </span>
                          <span className="text-[10px] text-muted-foreground/40 font-mono shrink-0">
                            {m.isFree ? 'free' : ''}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2.5 border-t border-border/30">
              <button
                onClick={() => { onClose(); onNavigate('/settings'); }}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition"
              >
                <Plus className="size-3" />
                Add provider
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
