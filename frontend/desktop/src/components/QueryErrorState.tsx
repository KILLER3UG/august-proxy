/* ── QueryErrorState — one honest failure card for list-shaped surfaces ──── */
/* A failed query is not an empty result. Surfaces that render "nothing here"
 * for both cases lie to the user, and worse, some of them auto-open a
 * create/duplicate form when the list comes back empty — so a transient 500
 * looks like "you have no automations, go make one". This is the shared
 * replacement: say the request failed, show why, and offer Retry.           */

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Turn whatever React Query handed us (Error, ApiError, string, …) into one
 *  readable line. Never empty — an unnamed failure is its own dead end. */
export function queryErrorMessage(error: unknown, fallback = 'The request failed.'): string {
  if (!error) return fallback;
  if (typeof error === 'string') return error.trim() || fallback;
  if (error instanceof Error) return error.message.trim() || fallback;
  const maybe = error as { message?: unknown; error?: unknown; status?: unknown };
  if (typeof maybe.message === 'string' && maybe.message.trim()) return maybe.message.trim();
  if (typeof maybe.error === 'string' && maybe.error.trim()) return maybe.error.trim();
  if (typeof maybe.status === 'number') return `Request failed (HTTP ${maybe.status}).`;
  return fallback;
}

interface QueryErrorStateProps {
  /** The query's `error` (unknown — anything React Query can hold). */
  error: unknown;
  /** Usually `() => void refetch()`. Omit to render without a Retry button. */
  onRetry?: () => void;
  /** Retry in flight — the button shows progress and disables itself. */
  retrying?: boolean;
  /** Short headline, e.g. "Couldn't load automations". */
  title?: string;
  /** Overrides the derived message from `error`. */
  message?: string;
  /** Extra reassurance / next step. Defaults to saying this is NOT empty. */
  note?: string;
  className?: string;
  /** Rail-sized variant (sidebar, tight columns). */
  compact?: boolean;
}

export function QueryErrorState({
  error,
  onRetry,
  retrying = false,
  title = "Couldn't load this",
  message,
  note = 'Nothing is shown here because the request failed — this is not an empty result.',
  className,
  compact = false,
}: QueryErrorStateProps) {
  const detail = message ?? queryErrorMessage(error);
  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="query-error-state"
      className={cn(
        'rounded-xl border border-destructive/30 bg-destructive/[0.06] text-center',
        compact ? 'px-3 py-3' : 'p-6',
        className,
      )}
    >
      <div
        className={cn(
          'mx-auto grid place-items-center rounded-full bg-destructive/10 text-destructive',
          compact ? 'size-6' : 'size-9',
        )}
        aria-hidden
      >
        <AlertTriangle className={compact ? 'size-3.5' : 'size-5'} />
      </div>
      <p className={cn('font-medium text-foreground', compact ? 'mt-1.5 text-[11px]' : 'mt-2.5 text-sm')}>
        {title}
      </p>
      <p
        className={cn(
          'text-muted-foreground break-words',
          compact ? 'mt-0.5 text-[10.5px]' : 'mx-auto mt-1 max-w-md text-xs',
        )}
        data-testid="query-error-message"
      >
        {detail}
      </p>
      {note && (
        <p
          className={cn(
            'text-muted-foreground/70',
            compact ? 'mt-0.5 text-[10px]' : 'mx-auto mt-1 max-w-md text-[11px]',
          )}
        >
          {note}
        </p>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          data-testid="query-error-retry"
          className={cn(
            'mt-3 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 font-medium text-foreground transition hover:bg-muted disabled:opacity-60',
            compact ? 'px-2 py-1 text-[10.5px]' : 'px-3 py-1.5 text-xs',
          )}
        >
          <RefreshCw className={cn('size-3', retrying && 'animate-spin')} />
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}
