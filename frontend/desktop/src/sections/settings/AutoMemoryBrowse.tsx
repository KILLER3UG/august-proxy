/* ── Shared Claude-style Memory browse (list → detail) ─────────────── */
/* Used by Recalled Memory (origin=recalled) and Added Memory (origin=added). */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, BrainCircuit, Check, Loader2, Network, SendHorizontal, Sparkles, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import { SettingsSectionShell } from '@/components/settings/SettingsSectionShell';
import { cn, formatTimeAgo } from '@/lib/utils';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';

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
  section?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  confidence?: number;
  ttlDays?: number | null;
  pinned?: boolean;
  sourceSessionId?: string;
  candidateReason?: string;
  candidateScore?: number;
  graph?: {
    entity?: string | null;
    entityLabel?: string | null;
    relationCount?: number;
    observationCount?: number;
    relations?: Array<{ target: string; type: string; label?: string }>;
  };
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
  folderId,
  embedded = false,
}: {
  origin: MemoryOrigin;
  title: string;
  subtitle: string;
  emptyTitle: string;
  emptyHint: string;
  listComposerPlaceholder: string;
  detailComposerPlaceholder: string;
  showListComposer: boolean;
  /** Project (folder) filter — only memories from sessions in this folder. */
  folderId?: string;
  /** Nested in the Memory hub — no second page title. */
  embedded?: boolean;
}) {
  const { state: confirmState, confirm: confirmStyled, handleConfirm, handleCancel } =
    useConfirmDialog();
  const qc = useQueryClient();
  const queryKey = ['auto-memory', origin, folderId ?? ''] as const;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [composerText, setComposerText] = useState('');
  const [reviewMode, setReviewMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const memoriesQuery = useQuery<AutoMemoryListResponse>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({ origin });
      if (folderId) params.set('folder_id', folderId);
      return api.get<AutoMemoryListResponse>(`/api/memory/auto?${params.toString()}`);
    },
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

  const bulkMutation = useMutation({
    mutationFn: (body: { ids: number[]; action: string }) =>
      api.post<{ applied: number }>('/api/memory/auto/bulk', body),
    onSuccess: (data, vars) => {
      toast.success(`${vars.action}: ${data.applied} applied`);
      setSelectedIds(new Set());
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => toast.error(e.message || 'Bulk action failed'),
  });

  const reviewReviewMutation = useMutation({
    mutationFn: () =>
      api.post<{ improve: unknown[]; remove: unknown[]; enhance: unknown[]; message?: string }>('/api/memory/review', {
        origin,
        folder_id: folderId ?? '',
      }),
    onSuccess: (data) => {
      toast.success(data.message || `Review: ${data.improve.length} improve, ${data.remove.length} remove, ${data.enhance.length} enhance`);
    },
    onError: (e: Error) => toast.error(e.message || 'Review failed'),
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

  const handleDetailEdit = async () => {
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
      if (
        await confirmStyled({
          title: 'Delete memory?',
          message: `Delete memory "${titleOf(selected)}"?`,
          confirmLabel: 'Delete',
          variant: 'destructive',
        })
      ) {
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

  function confidencePill(row: AutoMemoryRow) {
    const c = row.confidence;
    if (c == null) return null;
    const pct = Math.round(c * 100);
    const cls =
      c >= 0.7 ? 'bg-emerald-500/15 text-emerald-600' : c >= 0.45 ? 'bg-amber-500/15 text-amber-600' : 'bg-red-500/15 text-red-600';
    // Confidence is derived at write time (pinned 90%, general 70%, chat/
    // telemetry 45%, generic phrasing lower) — not a per-row model score.
    return (
      <span
        className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', cls)}
        title={`Confidence ${pct}% — derived from memory kind and pinned state (pinned 90%, general 70%, chat logs 45%)`}
      >
        {pct}%
      </span>
    );
  }
  function ttlPill(row: AutoMemoryRow) {
    if (!row.expiresAt) return null;
    const exp = Date.parse(String(row.expiresAt));
    if (Number.isNaN(exp)) return null;
    const days = Math.round((exp - Date.now()) / 86400000);
    if (days < 0) return <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-600">expired</span>;
    if (days <= 2) return <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">{days}d left</span>;
    return <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{days}d</span>;
  }

  const renderSection = (label: string, rows: AutoMemoryRow[]) => {
    if (rows.length === 0) return null;
    return (
      <div className="space-y-1.5">
        <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
        <div className="overflow-hidden rounded-lg border border-border/70 bg-card/40 divide-y divide-border/50">
          {rows.map((row) => {
            const checked = selectedIds.has(row.id);
            return (
              <div key={row.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/30">
                {reviewMode ? (
                  <button
                    type="button"
                    aria-label={checked ? 'Deselect' : 'Select'}
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded border text-[10px]',
                      checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background',
                    )}
                    onClick={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (checked) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                  >
                    {checked ? <Check className="size-3" /> : null}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                  onClick={() => {
                    setSelectedId(row.id);
                    setComposerText('');
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{titleOf(row)}</span>
                  <span className="min-w-0 flex-[1.4] truncate text-xs text-muted-foreground">{summaryOf(row)}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {confidencePill(row)}
                    {ttlPill(row)}
                    {row.candidateReason ? (
                      <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-700">{row.candidateReason}</span>
                    ) : null}
                    {row.graph && (row.graph.relationCount ?? 0) > 0 ? (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-600">
                        <Network className="size-2.5" />
                        {row.graph.relationCount}
                      </span>
                    ) : null}
                    <span className="whitespace-nowrap text-[10px] text-muted-foreground/70">
                      {row.updatedAt ? `Updated ${formatTimeAgo(row.updatedAt)}` : row.createdAt ? `Updated ${formatTimeAgo(row.createdAt)}` : ''}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  if (selected) {
    const details = detailsOf(selected);
    const detailBody = (
      <>
        <div className="flex items-center justify-between gap-3 border-b border-border/50 px-1 py-3">
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
            onClick={async () => {
              if (
                await confirmStyled({
                  title: 'Delete memory?',
                  message: `Delete memory "${titleOf(selected)}"?`,
                  confirmLabel: 'Delete',
                  variant: 'destructive',
                })
              ) {
                deleteMutation.mutate(selected.id);
              }
            }}
          >
            <Trash2 className="size-3.5" />
            Delete
          </button>
        </div>

        <div className="space-y-6 py-4">
          <h2 className="text-xl font-semibold tracking-tight">{titleOf(selected)}</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {confidencePill(selected)}
            {ttlPill(selected)}
            {selected.pinned ? <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">pinned</span> : null}
            {selected.graph?.relationCount ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-600">
                <Network className="size-3" /> {selected.graph.relationCount} relations
              </span>
            ) : null}
            {selected.candidateReason ? (
              <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-700">{selected.candidateReason}</span>
            ) : null}
          </div>

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
          {selected.graph?.relations?.length ? (
            <section className="space-y-2">
              <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <Network className="size-4" /> Graph
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {selected.graph.relations.map((r, i) => (
                  <span key={`${r.target}-${i}`} className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {r.type} → {r.target}
                  </span>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-border/60 bg-background/80 py-3">
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
        <ConfirmDialog
          open={confirmState.open}
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          cancelLabel={confirmState.cancelLabel}
          variant={confirmState.variant}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      </>
    );
    if (embedded) {
      return <div className="rounded-xl border border-border/50 bg-card/30 px-3">{detailBody}</div>;
    }
    return (
      <SettingsSectionShell
        title={title}
        subtitle={subtitle}
        className="h-full"
        bodyClassName="px-6 pb-0 flex flex-col"
      >
        {detailBody}
      </SettingsSectionShell>
    );
  }

  const listBody = (
    <>
      <div className="flex items-center gap-2 px-1 py-1">
        <button
          type="button"
          className={cn('rounded-full px-2.5 py-1 text-xs font-medium', reviewMode ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80')}
          onClick={() => {
            setReviewMode((v) => !v);
            if (reviewMode) setSelectedIds(new Set());
          }}
        >
          {reviewMode ? 'Done reviewing' : 'Review'}
        </button>
        {reviewMode ? (
          <>
            <span className="text-xs text-muted-foreground">{selectedIds.size} selected</span>
            <button type="button" className="rounded-full bg-emerald-500 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40" disabled={selectedIds.size === 0 || bulkMutation.isPending} onClick={() => bulkMutation.mutate({ ids: [...selectedIds], action: 'keep' })}>
              Keep
            </button>
            <button type="button" className="rounded-full bg-red-500 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40" disabled={selectedIds.size === 0 || bulkMutation.isPending} onClick={async () => {
              if (await confirmStyled({ title: 'Remove memories?', message: `Remove ${selectedIds.size} memories?`, confirmLabel: 'Remove', variant: 'destructive' })) bulkMutation.mutate({ ids: [...selectedIds], action: 'remove' });
            }}>
              Remove
            </button>
            <button type="button" className="rounded-full bg-violet-500 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40" disabled={selectedIds.size === 0 || bulkMutation.isPending} onClick={() => bulkMutation.mutate({ ids: [...selectedIds], action: 'pin' })}>
              Pin
            </button>
            <button type="button" className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-500 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40" disabled={reviewReviewMutation.isPending} onClick={() => reviewReviewMutation.mutate()}>
              <Sparkles className="size-3" /> Ask model to review
            </button>
          </>
        ) : (
          <button type="button" className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => reviewReviewMutation.mutate()} disabled={reviewReviewMutation.isPending}>
            {reviewReviewMutation.isPending ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />} Model review
          </button>
        )}
      </div>
      <div className={cn(embedded ? 'space-y-4' : 'flex-1 overflow-auto px-6 pb-4 space-y-5')}>
        {memoriesQuery.isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
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
        <div className={cn('shrink-0', embedded ? 'pt-3' : 'border-t border-border/60 bg-background/80 px-6 py-3')}>
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
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        cancelLabel={confirmState.cancelLabel}
        variant={confirmState.variant}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </>
  );

  if (embedded) {
    return <div className="space-y-1">{listBody}</div>;
  }

  return (
    <SettingsSectionShell
      title={title}
      subtitle={subtitle}
      className="h-full"
      bodyClassName="px-0 pb-0 flex flex-col"
    >
      {listBody}
    </SettingsSectionShell>
  );
}

