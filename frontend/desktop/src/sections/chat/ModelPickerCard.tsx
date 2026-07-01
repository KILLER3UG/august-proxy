/**
 * ModelPickerCard — Inline model picker for voice commands
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 *
 * Grouped-by-provider list of available models fetched via useModels().
 * Implements VoiceCommandCardProps so it plugs into the registry.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { Search, X, Zap, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useModels } from '@/hooks/useModels';
import type { VoiceCommandCardProps } from '@/api/voice/registry';
import { useNavigate } from 'react-router-dom';

export function ModelPickerCard({ onDismiss }: VoiceCommandCardProps) {
  const { models, isLoading, error } = useModels();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus search on mount.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Group by provider.
  const grouped = useMemo(() => {
    const map = new Map<string, typeof models>();
    for (const m of models) {
      const key = m.provider || 'Unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return Array.from(map.entries()).map(([provider, items]) => ({
      provider,
      items: items.filter(
        m =>
          m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          m.provider.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    }));
  }, [models, searchQuery]);

  // Flatten the grouped items so focusedIndex maps to a linear list.
  const flatItems = useMemo(
    () => grouped.flatMap(g => g.items),
    [grouped],
  );

  // Keyboard navigation.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex(i => Math.min(i + 1, flatItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && flatItems[focusedIndex]) {
        e.preventDefault();
        const model = flatItems[focusedIndex];
        // Select model via a custom event or direct store mutation.
        // For now, emit a toast and dismiss the card.
        handleSelect(model.id, model.provider);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [focusedIndex, flatItems, onDismiss]);

  useEffect(() => {
    setFocusedIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (listRef.current) {
      const items = listRef.current.querySelectorAll('[data-model-item]');
      const focused = items[focusedIndex] as HTMLElement;
      if (focused) {
        focused.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [focusedIndex]);

  const handleSelect = (modelId: string, provider: string) => {
    // v4.5: Wire to session model-update store mutation.
    // For now, emit a custom event so ChatThread can catch it.
    window.dispatchEvent(
      new CustomEvent('august:model-selected', {
        detail: { modelId, provider },
      }),
    );
    onDismiss();
  };

  // ── Empty / Error states ──────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="my-3 mx-auto max-w-2xl bg-card border border-border rounded-lg shadow-lg p-8 text-center text-sm text-muted-foreground">
        Loading models…
      </div>
    );
  }

  if (error) {
    return (
      <div className="my-3 mx-auto max-w-2xl bg-card border border-border rounded-lg shadow-lg p-8 text-center text-sm text-red-500">
        Failed to load models.
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="my-3 mx-auto max-w-2xl bg-card border border-border rounded-lg shadow-lg overflow-hidden">
        <div className="px-4 py-8 text-center space-y-3">
          <Zap className="size-6 text-muted-foreground mx-auto" />
          <div className="text-sm text-foreground font-medium">
            No models available
          </div>
          <div className="text-xs text-muted-foreground">
            Add a provider in Settings to get started.
          </div>
          <button
            type="button"
            onClick={() => {
              navigate('/settings/providers');
              onDismiss();
            }}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            <Settings className="size-3" />
            Go to Settings
          </button>
        </div>
      </div>
    );
  }

  // ── Normal render ─────────────────────────────────────────────────────

  return (
    <div className="my-3 mx-auto max-w-2xl bg-card border border-border rounded-lg shadow-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-primary" />
          <span className="text-sm font-medium">Switch Model</span>
        </div>
        <button
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Search */}
      <div className="px-4 py-3 border-b border-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search models…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
      </div>

      {/* Grouped model list */}
      <div ref={listRef} className="max-h-80 overflow-y-auto">
        {grouped.map(group => {
          if (group.items.length === 0) return null;
          const groupStart = flatItems.indexOf(group.items[0]);
          return (
            <div key={group.provider}>
              <div className="px-4 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold bg-muted/10">
                {group.provider}
              </div>
              {group.items.map((model, idx) => {
                const globalIdx = groupStart + idx;
                const isFocused = globalIdx === focusedIndex;
                return (
                  <button
                    key={model.id}
                    data-model-item
                    onClick={() => handleSelect(model.id, model.provider)}
                    className={cn(
                      'w-full px-4 py-3 flex items-start gap-3 text-left transition-colors',
                      isFocused && 'bg-muted',
                      !isFocused && 'hover:bg-muted/50',
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{model.name}</span>
                        {(model as any).isFree && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">
                            Free
                          </span>
                        )}
                        {(model as any).supportsReasoning && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">
                            Reasoning
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {model.contextWindow
                          ? `${(model.contextWindow / 1000).toFixed(0)}K context`
                          : '—'}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
        {flatItems.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No models matching &ldquo;{searchQuery}&rdquo;
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-2 bg-muted/30 border-t border-border text-xs text-muted-foreground">
        <kbd className="px-1.5 py-0.5 bg-background border border-border rounded">↑↓</kbd> navigate ·{' '}
        <kbd className="px-1.5 py-0.5 bg-background border border-border rounded ml-1">Enter</kbd> select ·{' '}
        <kbd className="px-1.5 py-0.5 bg-background border border-border rounded ml-1">Esc</kbd> close
      </div>
    </div>
  );
}
