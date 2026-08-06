/* ── MemorySuggestionBar ──────────────────────────────────────────────── */
/* "August noticed…" chips above the composer: deterministic preference
 * candidates from the last user turn, saved to the user profile with one
 * click (PATCH /api/brain/profile) or dismissed. Fed by the `done` SSE
 * event's memorySuggestions payload (backend F3). */

import { useSyncExternalStore } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, Check, X } from 'lucide-react';
import { api } from '@/api/client';
import {
  $memorySuggestions,
  dismissMemorySuggestion,
} from './memory-suggestions-store';

export function MemorySuggestionBar({ sessionId }: { sessionId: string | null }) {
  const bySession = useSyncExternalStore($memorySuggestions.subscribe, $memorySuggestions.get);
  const qc = useQueryClient();
  const suggestions = sessionId ? (bySession[sessionId] ?? []) : [];

  const saveFact = useMutation({
    mutationFn: (fact: string) => api.patch('/api/brain/profile', { addFact: fact }),
    onSuccess: (_res, fact) => {
      toast.success('Saved to your profile');
      if (sessionId) dismissMemorySuggestion(sessionId, fact);
      void qc.invalidateQueries({ queryKey: ['brain-learning'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Could not save fact'),
  });

  if (suggestions.length === 0) return null;

  return (
    <div
      className="mb-1.5 flex flex-wrap items-center gap-1.5 animate-in fade-in slide-in-from-bottom-1 duration-150"
      data-testid="memory-suggestion-bar"
    >
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
        <Sparkles className="size-3 text-primary" />
        August noticed
      </span>
      {suggestions.map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px]"
        >
          <span className="max-w-56 truncate" title={s}>
            “{s}”
          </span>
          <button
            type="button"
            title="Save as a profile fact"
            className="p-0.5 rounded text-success hover:bg-success/15 disabled:opacity-50"
            disabled={saveFact.isPending}
            data-testid={`save-memory-suggestion-${s.slice(0, 24)}`}
            onClick={() => saveFact.mutate(s)}
          >
            <Check className="size-3" />
          </button>
          <button
            type="button"
            title="Dismiss"
            className="p-0.5 rounded text-muted-foreground hover:bg-muted"
            onClick={() => sessionId && dismissMemorySuggestion(sessionId, s)}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
