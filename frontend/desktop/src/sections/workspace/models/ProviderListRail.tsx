/* Left-rail provider picker for the Providers view.
 * Lists every entry from the providers catalog, highlights the selection,
 * and exposes refresh / add-provider actions for the two-pane layout.
 */

import { RefreshCw, Plus, Server } from 'lucide-react';
import type { Provider } from '@/api/providers';
import { cn } from '@/lib/utils';

export function ProviderListRail({
  providers,
  selectedId,
  isFetching,
  onRefresh,
  onSelect,
  onAdd,
}: {
  providers: Provider[];
  selectedId: string | null;
  isFetching: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 flex flex-col overflow-hidden min-h-0 max-h-full md:max-h-none md:h-full">
      <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between shrink-0">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
          Providers
        </p>
        <button
          onClick={onRefresh}
          aria-label="Refresh providers"
          className="text-muted-foreground hover:text-foreground transition"
        >
          <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 space-y-0.5">
        {providers.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">No providers yet</p>
        ) : (
          providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              className={cn(
                'w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition',
                selectedId === p.id
                  ? 'bg-white/[0.06] text-foreground'
                  : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground',
              )}
            >
              <Server className="size-3.5 shrink-0" />
              <span className="flex-1 truncate">{p.name}</span>
              {p.enabled && <span className="size-2 rounded-full bg-success shrink-0" title="enabled" />}
            </button>
          ))
        )}
      </div>
      <div className="border-t border-white/[0.06] p-2 shrink-0">
        <button
          type="button"
          onClick={onAdd}
          className="w-full flex items-center justify-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-white/[0.04] transition"
        >
          <Plus className="size-3.5" />
          Add provider
        </button>
      </div>
    </div>
  );
}
