/**
 * ModelPickerCard — Inline model picker for voice commands
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 *
 * Grouped-by-provider list of available models fetched via useModels().
 * Implements VoiceCommandCardProps so it plugs into the registry.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, X, Zap, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useModels } from '@/hooks/useModels';
import { useProviderAvailability } from '@/hooks/useProviderAvailability';
import { StatusDot } from '@/components/workspace/StatusPill';
import type { VoiceCommandCardProps } from '@/api/voice/registry';
import { useNavigate } from 'react-router-dom';
import { flattenGroups, groupModelsByProvider } from '@/components/model/modelList';
import { getModelDisplayName } from './model-display';

export function ModelPickerCard({ onDismiss, context }: VoiceCommandCardProps) {
  const { models, isLoading, error } = useModels();
  const { providers: providerAvailability, refetch: refetchAvailability } = useProviderAvailability();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus search on mount.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Map provider name → availability status.
  const providerStatus = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const p of providerAvailability) {
      map.set(p.id, p.isAvailable);
      map.set(p.name, p.isAvailable);
    }
    return map;
  }, [providerAvailability]);

  // Group by provider and rank inside each group. Shared with the settings
  // picker: this card sorted by nothing, so a pinned model sat wherever the API
  // happened to return it while the composer moved it to the top.
  const grouped = useMemo(
    () => groupModelsByProvider(models, searchQuery),
    [models, searchQuery],
  );

  // F2: providers confirmed unavailable sink to a collapsed group with a
  // "check again" action instead of masquerading as first-class options.
  const availableGroups = useMemo(
    () => grouped.filter(g => providerStatus.get(g.provider) !== false),
    [grouped, providerStatus],
  );
  const unavailableGroups = useMemo(
    () => grouped.filter(g => providerStatus.get(g.provider) === false),
    [grouped, providerStatus],
  );

  const handleSelect = useCallback((modelId: string, provider: string) => {
    window.dispatchEvent(
      new CustomEvent('august:model-selected', {
        detail: { modelId, provider },
      }),
    );
    onDismiss();
  }, [onDismiss]);

  // The cursor indexes what is actually painted. `grouped` still holds the
  // unavailable providers — those render as plain text inside a collapsed
  // disclosure, not as buttons — so flattening it let ArrowDown walk the cursor
  // off the end of the visible list and Enter select a model from a provider
  // already confirmed down, which the user never saw offered.
  const navigable = useMemo(() => flattenGroups(availableGroups), [availableGroups]);

  // The caller has passed the model in use all along; nothing read it. Announcing
  // it is the point of a card titled "Switch Model", and on a listbox
  // aria-selected means "this is the chosen one" — so it cannot double as the
  // keyboard cursor, which is a different fact about a different row.
  const currentModelId =
    typeof context?.currentModelId === 'string' ? context.currentModelId : '';

  // Keyboard navigation.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex(i => Math.min(i + 1, Math.max(navigable.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && navigable[focusedIndex]) {
        e.preventDefault();
        const model = navigable[focusedIndex];
        // Not a no-op: ChatThread owns the august:model-selected listener and
        // runs the full switch there (stop + handoff when streaming,
        // server-computed handoff notice, auto-continue the interrupted prompt),
        // the same path the composer menu uses.
        handleSelect(model.id, model.provider);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [focusedIndex, navigable, onDismiss, handleSelect]);

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
      <div className="my-3 mx-auto max-w-2xl bg-card border border-border rounded-lg shadow-lg p-8 text-center text-sm text-danger-fg">
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
              void navigate('/settings/providers');
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
      <div
        ref={listRef}
        role="listbox"
        aria-label="Available models"
        aria-activedescendant={navigable[focusedIndex] ? `model-option-${focusedIndex}` : undefined}
        className="max-h-80 overflow-y-auto"
      >
        {availableGroups.map(group => {
          if (group.items.length === 0) return null;
          const groupStart = navigable.indexOf(group.items[0]);
          return (
            <div key={group.provider} role="presentation">
              <div className="px-4 py-1.5 text-2xs uppercase tracking-wide text-muted-foreground font-semibold bg-muted/10">
                {group.provider}
              </div>
              {group.items.map((model, idx) => {
                const globalIdx = groupStart + idx;
                const isFocused = globalIdx === focusedIndex;
                const isCurrent = model.id === currentModelId;
                return (
                  <button
                    key={model.id}
                    id={`model-option-${globalIdx}`}
                    data-model-item
                    role="option"
                    // aria-selected is the model in use. The keyboard cursor is a
                    // separate fact and gets its own background plus a marker,
                    // so neither signal relies on colour alone.
                    aria-selected={isCurrent}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => handleSelect(model.id, model.provider)}
                    onMouseEnter={() => setFocusedIndex(globalIdx)}
                    className={cn(
                      'w-full px-4 py-3 flex items-start gap-3 text-left transition-colors',
                      isFocused && 'bg-muted',
                      !isFocused && 'hover:bg-muted/50',
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusDot
                          tone={
                            providerStatus.get(model.provider) === false
                              ? 'bad'
                              : providerStatus.get(model.provider) === true
                                ? 'good'
                                : 'muted'
                          }
                          className="shrink-0"
                          title={
                            providerStatus.get(model.provider) === false
                              ? 'Provider unavailable'
                              : providerStatus.get(model.provider) === true
                                ? 'Provider available'
                                : 'Provider status not checked yet'
                          }
                        />
                        {/* A model with no `name` from the provider rendered as an
                         *  empty row — the same gap that made the old search
                         *  unable to find it. Derived display name as the floor. */}
                        <span className="text-sm font-medium">
                          {model.name || getModelDisplayName(model.id)}
                        </span>
                        {isCurrent && (
                          <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-2xs font-medium text-primary">
                            In use
                          </span>
                        )}
                        {model.isFree && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-success/10 text-success-fg text-success-fg">
                            Free
                          </span>
                        )}
                        {model.supportsReasoning && (
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
        {unavailableGroups.length > 0 && (
          <details className="border-t border-border/60">
            <summary className="px-4 py-1.5 text-2xs uppercase tracking-wide text-muted-foreground/60 font-semibold cursor-pointer hover:text-muted-foreground flex items-center justify-between gap-2">
              <span>
                Unavailable providers ({unavailableGroups.reduce((n, g) => n + g.items.length, 0)})
              </span>
              <button
                type="button"
                className="normal-case tracking-normal text-2xs text-primary hover:underline"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void refetchAvailability();
                }}
              >
                Check again
              </button>
            </summary>
            <div className="px-4 pb-2">
              {unavailableGroups.map(group => (
                <p key={group.provider} className="text-xs text-muted-foreground/70 py-0.5">
                  {group.provider} — {group.items
                    .map((m) => m.name || getModelDisplayName(m.id))
                    .join(', ')}
                </p>
              ))}
            </div>
          </details>
        )}
        {navigable.length === 0 && (
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
