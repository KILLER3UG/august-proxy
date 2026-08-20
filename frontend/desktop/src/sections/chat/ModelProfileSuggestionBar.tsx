/* ── ModelProfileSuggestionBar ─ capability-profile Apply / Dismiss chip ─ */
/* Capability auto-detect suggested a per-model toolSurface from turn       */
/* traces. Apply persists via POST /api/models/profile (same path the       */
/* AUGUST_AUTO_PROFILE=1 env opt-in uses); Dismiss just clears the chip.    */

import { useSyncExternalStore } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Sparkles, X } from 'lucide-react';
import { providersApi } from '@/api/providers';
import {
  $modelProfileSuggestions,
  clearModelProfileSuggestion,
} from './model-profile-store';

export function ModelProfileSuggestionBar({ sessionId }: { sessionId: string | null }) {
  const bySession = useSyncExternalStore(
    $modelProfileSuggestions.subscribe,
    $modelProfileSuggestions.get,
  );
  const qc = useQueryClient();
  const suggestion = sessionId ? bySession[sessionId] : undefined;

  const apply = useMutation({
    mutationFn: (s: { model: string; toolSurface?: string }) =>
      providersApi.applyModelProfile(s.model, s.toolSurface),
    onSuccess: (_res, vars) => {
      toast.success(
        vars.toolSurface
          ? `Tool surface set to ${vars.toolSurface} for ${vars.model}`
          : 'Profile override cleared',
      );
      if (sessionId) clearModelProfileSuggestion(sessionId);
      void qc.invalidateQueries({ queryKey: ['providers'] });
      void qc.invalidateQueries({ queryKey: ['models'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Could not apply profile'),
  });

  if (!suggestion) return null;

  return (
    <div
      className="w-full rounded-xl border border-primary/40 bg-primary/[0.06] px-3 py-2 text-xs space-y-1.5"
      data-testid="model-profile-suggestion-bar"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-primary" />
        <p className="font-medium text-foreground">
          August detected a capability profile for {suggestion.model}
        </p>
        <button
          type="button"
          aria-label="Dismiss suggestion"
          className="ml-auto p-1 rounded text-muted-foreground hover:text-foreground"
          onClick={() => sessionId && clearModelProfileSuggestion(sessionId)}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {suggestion.toolSurface && (
        <p className="pl-5 text-muted-foreground/90">
          Suggesting tool surface{' '}
          <span className="font-mono text-foreground/80">{suggestion.toolSurface}</span>
          {suggestion.reason ? (
            <span className="text-muted-foreground/70"> — {suggestion.reason}</span>
          ) : null}
        </p>
      )}
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={apply.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground disabled:opacity-50"
          data-testid="profile-apply"
          onClick={() =>
            apply.mutate({ model: suggestion.model, toolSurface: suggestion.toolSurface })
          }
        >
          <Check className="size-3" />
          Apply
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          onClick={() => sessionId && clearModelProfileSuggestion(sessionId)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
