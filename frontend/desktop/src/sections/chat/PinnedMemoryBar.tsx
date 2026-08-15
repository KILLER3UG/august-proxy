/* Always-include memories — chips above the composer, unpin in place. */

import { Pin, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';

interface AutoMemoryRow {
  id?: number;
  content?: unknown;
  pinned?: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'text' in content) {
    return String((content as { text?: unknown }).text ?? '');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

export function PinnedMemoryBar() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['pinned-memories'],
    queryFn: async () => {
      const res = await api.get<{ items?: AutoMemoryRow[] }>('/api/memory/auto?origin=all');
      return (res.items ?? []).filter((row) => row.pinned);
    },
    refetchInterval: 60_000,
  });
  const unpin = useMutation({
    mutationFn: (id: number) => api.put(`/api/memory/auto/${id}`, { pinned: false }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pinned-memories'] });
    },
  });

  const rows = (query.data ?? []).slice(0, 6);
  if (rows.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="pinned-memory-bar"
    >
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
        <Pin className="size-3 text-primary" />
        Always include
      </span>
      {rows.map((row) => {
        const id = Number(row.id);
        const label = textOf(row.content);
        return (
          <span
            key={id}
            className="inline-flex max-w-56 items-center gap-1 rounded-full border border-border/60 bg-muted/25 px-2 py-0.5 text-[11px] text-foreground/85"
            title={label}
          >
            <span className="truncate">{label}</span>
            <button
              type="button"
              className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Stop always-including"
              onClick={() => Number.isFinite(id) && unpin.mutate(id)}
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
