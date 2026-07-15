import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FIELD } from './styles';

export type DirectoryMode = 'directory' | 'custom';
export type DirectoryFilter = 'all' | 'account' | 'mcp';

interface DirectoryToolbarProps {
  mode: DirectoryMode;
  filter: DirectoryFilter;
  query: string;
  onModeChange: (mode: DirectoryMode) => void;
  onFilterChange: (filter: DirectoryFilter) => void;
  onQueryChange: (query: string) => void;
  onClearError: () => void;
}

/**
 * Mode switch (Directory / Create custom) plus search + kind filters when
 * browsing the catalog.
 */
export function DirectoryToolbar({
  mode,
  filter,
  query,
  onModeChange,
  onFilterChange,
  onQueryChange,
  onClearError,
}: DirectoryToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-5 py-3">
      <div className="flex rounded-lg border border-white/[0.08] p-0.5 bg-white/[0.03]">
        {(
          [
            ['directory', 'Directory'],
            ['custom', 'Create custom'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              onModeChange(id);
              onClearError();
            }}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition',
              mode === id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            data-testid={`integrations-mode-${id}`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'directory' && (
        <>
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search directory…"
              className={cn('w-full py-2 pl-9 pr-3 text-sm', FIELD)}
            />
          </div>
          {(['all', 'account', 'mcp'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onFilterChange(f)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition',
                filter === f
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-white/[0.06] text-muted-foreground hover:text-foreground',
              )}
            >
              {f === 'all' ? 'All' : f === 'account' ? 'Accounts' : 'MCP extensions'}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
