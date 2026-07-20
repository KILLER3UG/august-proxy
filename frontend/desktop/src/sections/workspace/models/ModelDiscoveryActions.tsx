/* Model discovery controls for a single provider.
 * Toggles auto-fetch from /v1/models and triggers an immediate refresh via
 * providersApi.refreshModels so the provider's model list stays current.
 */

import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ModelDiscoveryActions({
  autoFetch,
  refreshPending,
  canRefresh,
  onRefresh,
  onToggleAutoFetch,
}: {
  autoFetch: boolean;
  refreshPending: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  onToggleAutoFetch: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/[0.06] p-3">
      <div>
        <p className="text-sm font-medium">
          Model discovery from <code className="text-xs font-mono">baseUrl/models</code>
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          When on, August finds every model the provider exposes and adds them here.
          Use the refresh icon to re-discover now.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onRefresh}
          disabled={refreshPending || !canRefresh}
          aria-label="Refresh models now"
          className="text-muted-foreground hover:text-foreground transition disabled:opacity-50"
        >
          <RefreshCw className={cn('size-3.5', refreshPending && 'animate-spin')} />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={autoFetch}
          onClick={() => onToggleAutoFetch(!autoFetch)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition',
            autoFetch ? 'bg-primary' : 'bg-white/[0.15]',
          )}
        >
          <span
            className={cn(
              'inline-block size-4 transform rounded-full bg-white shadow transition',
              autoFetch ? 'translate-x-4' : 'translate-x-0.5',
            )}
          />
        </button>
      </div>
    </div>
  );
}
