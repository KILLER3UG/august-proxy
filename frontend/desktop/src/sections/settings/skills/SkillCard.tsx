/* Catalog card: opens detail on click; pin/archive/restore on hover actions. */

import { Archive, Pin, PinOff, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SkillRow } from './types';

function StateBadge({ state }: { state: string }) {
  const config: Record<string, { label: string; className: string }> = {
    active: { label: 'Active', className: 'bg-success/20 text-success' },
    stale: { label: 'Stale', className: 'bg-warning/20 text-warning' },
    archived: { label: 'Archived', className: 'bg-muted text-muted-foreground' },
  };
  const c = config[state] ?? { label: state, className: 'bg-muted text-muted-foreground' };
  return (
    <Badge variant="outline" className={c.className}>
      {c.label}
    </Badge>
  );
}

function RowIconButton({
  children,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition"
    >
      {children}
    </button>
  );
}

export function SkillCard({
  row,
  onOpen,
  onTogglePin,
  onArchive,
  onRestore,
}: {
  row: SkillRow;
  onOpen: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group relative w-full rounded-xl border border-border/60 bg-card p-4 text-left cursor-pointer',
        'transition hover:border-border hover:bg-card/90',
        'focus:outline-none focus:ring-1 focus:ring-primary/40',
      )}
      data-testid={`skill-card-${row.name}`}
    >
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-border/50 bg-muted/40 text-sm font-semibold text-foreground">
          {row.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">{row.name}</span>
            {row.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {row.description || 'No description'}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StateBadge state={row.state} />
            <span className="rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              {row.source}
            </span>
            {row.useCount > 0 && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {row.useCount} use{row.useCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
      </div>
      <div
        className="mt-3 flex items-center justify-end gap-1 opacity-0 transition group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <RowIconButton title={row.pinned ? 'Unpin' : 'Pin'} onClick={onTogglePin}>
          {row.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        </RowIconButton>
        <RowIconButton title="Archive" onClick={onArchive} disabled={row.state === 'archived'}>
          <Archive className="size-4" />
        </RowIconButton>
        <RowIconButton title="Restore" onClick={onRestore} disabled={row.state !== 'archived'}>
          <RotateCcw className="size-4" />
        </RowIconButton>
      </div>
    </div>
  );
}
