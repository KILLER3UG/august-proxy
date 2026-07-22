/* ── Shared Claude-style Memory browse (list → detail) ─────────────── */
/* Used by Recalled Memory (origin=recalled) and Added Memory (origin=added). */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, BrainCircuit, Loader2, SendHorizontal, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import { SettingsSectionShell } from '@/components/settings/SettingsSectionShell';
import { cn, formatTimeAgo } from '@/lib/utils';

export interface AutoMemoryRow {
  id: number;
  key: string;
  content: unknown;
  category: string;
  importance: number;
  source?: string;
  origin?: string;
  title?: string;
  summary?: string;
  details?: string[];
  section?: 'topics' | 'areas' | string;
  createdAt?: string;
  updatedAt?: string;
}

interface AutoMemoryListResponse {
  items: AutoMemoryRow[];
  grouped: Record<string, AutoMemoryRow[]>;
  origin?: string;
}

export type MemoryOrigin = 'recalled' | 'added';

function titleOf(row: AutoMemoryRow): string {
  return (row.title || row.key || 'Memory').trim();
}

function summaryOf(row: AutoMemoryRow): string {
  if (row.summary?.trim()) return row.summary.trim();
  if (typeof row.content === 'string') return row.content;
  try {
    return JSON.stringify(row.content);
  } catch {
    return '';
  }
}

function detailsOf(row: AutoMemoryRow): string[] {
  if (Array.isArray(row.details) && row.details.length > 0) {
    return row.details.map(String);
  }
  const s = summaryOf(row);
  return s ? [s] : [];
}

function sectionOf(row: AutoMemoryRow): 'topics' | 'areas' {
  if (row.section === 'areas' || row.section === 'topics') return row.section;
  const cat = (row.category || '').toLowerCase();
  if (['correction', 'learning', 'preference', 'user'].includes(cat)) return 'areas';
  return 'topics';
}

export function AutoMemoryBrowse({
  origin,
  title,
  subtitle,
  emptyTitle,
  emptyHint,
  listComposerPlaceholder,
  detailComposerPlaceholder,
  showListComposer,
}: {
  origin: MemoryOrigin;
  title: string;
  subtitle: string;
  emptyTitle: string;
  emptyHint: string;
  listComposerPlaceholder: string;
  detailComposerPlaceholder: string;
  showListComposer: boolean;
}) {
  const qc = useQueryClient();
  const queryKey = ['auto-memory', origin] as const;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [composerText, setComposerText] = useState('');

  const memoriesQuery = useQuery<AutoMemoryListResponse>({
    queryKey,
    queryFn: () =>
      api.get<AutoMemoryListResponse>(
        `/api/memory/auto?origin=${encodeURIComponent(origin)}`,
      ),
    refetchInterval: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/memory/auto/${id}`),
    onSuccess: () => {
      toast.success('Memory deleted');
      setSelectedId(null);
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });

  const createMutation = useMutation({
    mutationFn: (body: {
      key: string;
      content: string;
      category: string;
      source: string;
      importance?: number;
    }) => api.post('/api/memory/auto', body),
    onSuccess: () => {
      setComposerText('');
      toast.success('Memory saved');
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => toast.error(e.message || 'Add failed'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, content }: { id: number; content: string }) =>
      api.put(`/api/memory/auto/${id}`, { content }),
    onSuccess: () => {
      setComposerText('');
      toast.success('Memory updated');
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => toast.error(e.message || 'Update failed'),
  });

  const items = memoriesQuery.data?.items ?? [];
  const selected = useMemo(
    () => items.find((r) => r.id === selectedId) ?? null,
    [items, selectedId],
  );

  const topics = useMemo(
    () => items.filter((r) => sectionOf(r) === 'topics'),
    [items],
  );
  const areas = useMemo(
    () => items.filter((r) => sectionOf(r) === 'areas'),
    [items],
  );

  const handleListAdd = () => {
    const text = composerText.trim();
    if (!text) return;
    createMutation.mutate({
      key: `added_${Date.now()}`,
      content: text,
      category: origin === 'added' ? 'user' : 'auto',
      source: origin === 'added' ? 'user' : 'auto',
      importance: origin === 'added' ? 0.9 : 0.5,
    });
  };

  const handleDetailEdit = () => {
    if (!selected) return;
    const text = composerText.trim();
    if (!text) return;
    const lower = text.toLowerCase();
    if (
      lower.startsWith('remove') ||
      lower.startsWith('delete') ||
      lower === 'clear' ||
      lower.startsWith('forget')
    ) {
      if (confirm(`Delete memory "${titleOf(selected)}"?`)) {
        deleteMutation.mutate(selected.id);
      }
      return;
    }
    const existing = typeof selected.content === 'string'
      ? selected.content
      : summaryOf(selected);
    const next =
      lower.startsWith('replace') || lower.startsWith('set ')
        ? text.replace(/^(replace|set)\s*(with|:)?\s*/i, '').trim() || text
        : `${existing}\n${text}`.trim();
    updateMutation.mutate({ id: selected.id, content: next });
  };

  const renderSection = (label: string, rows: AutoMemoryRow[]) => {
    if (rows.length === 0) return null;
    return (
      <div className="space-y-1.5">
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
        <div className="overflow-hidden rounded-lg border border-border/70 bg-card/40 divide-y divide-border/50">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/30 transition-colors"
              onClick={() => {
                setSelectedId(row.id);
                setComposerText('');
              }}
            >
              <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
                {titleOf(row)}
              </span>
              <span className="min-w-0 flex-[1.4] text-xs text-muted-foreground line-clamp-1">
                {summaryOf(row)}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/70 whitespace-nowrap">
                {row.updatedAt
                  ? `Updated ${formatTimeAgo(row.updatedAt)}`
                  : row.createdAt
                    ? `Updated ${formatTimeAgo(row.createdAt)}`
                    : ''}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  if (selected) {
    const details = detailsOf(selected);
    return (
      <SettingsSectionShell
        title={title}
        subtitle={subtitle}
        className="h-full"
        bodyClassName="px-0 pb-0 flex flex-col"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/50 px-6 py-3">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => {
              setSelectedId(null);
              setComposerText('');
            }}
          >
            <ArrowLeft className="size-4" />
            Memory
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/10"
            disabled={deleteMutation.isPending}
            onClick={() => {
              if (confirm(`Delete memory "${titleOf(selected)}"?`)) {
                deleteMutation.mutate(selected.id);
              }
            }}
          >
            <Trash2 className="size-3.5" />
            Delete
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight">{titleOf(selected)}</h2>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Summary</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {summaryOf(selected)}
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Details</h3>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground leading-relaxed">
              {details.map((d, i) => (
                <li key={`${i}-${d.slice(0, 24)}`}>{d}</li>
              ))}
            </ul>
          </section>
        </div>

        <div className="shrink-0 border-t border-border/60 bg-background/80 px-6 py-3">
          <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-muted/20 px-3 py-2">
            <input
              type="text"
              placeholder={detailComposerPlaceholder}
              className="h-9 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleDetailEdit();
              }}
            />
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
              disabled={updateMutation.isPending || deleteMutation.isPending || !composerText.trim()}
              onClick={handleDetailEdit}
              aria-label="Apply memory change"
            >
              {updateMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <SendHorizontal className="size-3.5" />
              )}
            </button>
          </div>
        </div>
      </SettingsSectionShell>
    );
  }

  return (
    <SettingsSectionShell
      title={title}
      subtitle={subtitle}
      className="h-full"
      bodyClassName="px-0 pb-0 flex flex-col"
    >
      <div className="flex-1 overflow-auto px-6 pb-4 space-y-5">
        {memoriesQuery.isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
            <BrainCircuit className="mx-auto mb-2 size-6 text-muted-foreground/60" />
            <p className="font-medium text-foreground/80">{emptyTitle}</p>
            <p className="mt-1">{emptyHint}</p>
          </div>
        ) : (
          <>
            {renderSection('Topics', topics)}
            {renderSection('Areas', areas)}
          </>
        )}
      </div>

      {showListComposer ? (
        <div className="shrink-0 border-t border-border/60 bg-background/80 px-6 py-3">
          <div
            className={cn(
              'flex items-center gap-2 rounded-xl border border-border/70 bg-muted/20 px-3 py-2',
            )}
          >
            <input
              type="text"
              placeholder={listComposerPlaceholder}
              className="h-9 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleListAdd();
              }}
            />
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
              disabled={createMutation.isPending || !composerText.trim()}
              onClick={handleListAdd}
              aria-label="Add memory"
            >
              {createMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <SendHorizontal className="size-3.5" />
              )}
            </button>
          </div>
        </div>
      ) : null}
    </SettingsSectionShell>
  );
}
