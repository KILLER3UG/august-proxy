/**
 * ModelPickerCard — Inline model picker for voice commands
 * 
 * Spec: docs/superpowers/specs/2026-06-30-voice-command-ui-infrastructure-design.md
 * 
 * Lightweight inline card (not a portal dropdown) that appears in the chat thread
 * when the user says "switch model" or types /model.
 */

import { useState, useEffect, useRef } from 'react';
import { Search, X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ModelPickerModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  isFree?: boolean;
  supportsReasoning?: boolean;
}

interface ModelPickerCardProps {
  models: ModelPickerModel[];
  currentModelId: string;
  onSelect: (modelId: string, provider: string) => void;
  onClose: () => void;
}

export function ModelPickerCard({ models, currentModelId, onSelect, onClose }: ModelPickerCardProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus search input on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Filter models by search query
  const filteredModels = models.filter(m =>
    m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.provider.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex(i => Math.min(i + 1, filteredModels.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filteredModels[focusedIndex]) {
        e.preventDefault();
        const model = filteredModels[focusedIndex];
        onSelect(model.id, model.provider);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [focusedIndex, filteredModels, onSelect, onClose]);

  // Reset focused index when search changes
  useEffect(() => {
    setFocusedIndex(0);
  }, [searchQuery]);

  // Scroll focused item into view
  useEffect(() => {
    if (listRef.current) {
      const items = listRef.current.querySelectorAll('[data-model-item]');
      const focused = items[focusedIndex];
      if (focused) {
        focused.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [focusedIndex]);

  return (
    <div className="my-3 mx-auto max-w-2xl bg-card border border-border rounded-lg shadow-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-primary" />
          <span className="text-sm font-medium">Switch Model</span>
        </div>
        <button
          onClick={onClose}
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
            placeholder="Search models..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
      </div>

      {/* Model List */}
      <div ref={listRef} className="max-h-80 overflow-y-auto">
        {filteredModels.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No models found matching "{searchQuery}"
          </div>
        )}
        {filteredModels.map((model, idx) => {
          const isCurrent = model.id === currentModelId;
          const isFocused = idx === focusedIndex;
          return (
            <button
              key={model.id}
              data-model-item
              onClick={() => onSelect(model.id, model.provider)}
              className={cn(
                'w-full px-4 py-3 flex items-start gap-3 text-left transition-colors',
                isFocused && 'bg-muted',
                isCurrent && 'bg-primary/10',
                !isCurrent && !isFocused && 'hover:bg-muted/50'
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={cn('text-sm font-medium', isCurrent && 'text-primary')}>
                    {model.name}
                  </span>
                  {model.isFree && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">
                      Free
                    </span>
                  )}
                  {model.supportsReasoning && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">
                      Reasoning
                    </span>
                  )}
                  {isCurrent && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {model.provider} · {(model.contextWindow / 1000).toFixed(0)}K context
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-2 bg-muted/30 border-t border-border text-xs text-muted-foreground">
        <kbd className="px-1.5 py-0.5 bg-background border border-border rounded">↑↓</kbd> navigate · 
        <kbd className="px-1.5 py-0.5 bg-background border border-border rounded ml-1">Enter</kbd> select · 
        <kbd className="px-1.5 py-0.5 bg-background border border-border rounded ml-1">Esc</kbd> close
      </div>
    </div>
  );
}
