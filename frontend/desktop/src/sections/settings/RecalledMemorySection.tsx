/* ── RecalledMemorySection — auto-memory CRUD (Claude Memory-style layout) ── */
/* Grouped by August's auto-memory categories with a pinned quick-add row.
 * Backed by /api/memory/auto (list/grouped, create, update, delete) —
 * see backend-py/app/routers/memory.py. */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BrainCircuit, Loader2, Plus, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import { SettingsSectionShell } from '@/components/settings/SettingsSectionShell';
import { formatTimeAgo } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface AutoMemoryRow {
  id: number;
  key: string;
  content: unknown;
  category: string;
  importance: number;
  createdAt?: string;
  updatedAt?: string;
}

interface AutoMemoryListResponse {
  items: AutoMemoryRow[];
  grouped: Record<string, AutoMemoryRow[]>;
}

/** Preferred display order for known August categories; anything else is
 *  appended afterwards, alphabetically. */
const CATEGORY_ORDER = ['auto', 'conversation', 'tasks', 'review', 'correction', 'learning'];

const CATEGORY_LABELS: Record<string, string> = {
  auto: 'Auto',
  conversation: 'Conversation',
  tasks: 'Tasks',
  review: 'Review',
  correction: 'Correction',
  learning: 'Learning',
};

function categoryLabel(category: string): string {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  return category
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function orderCategories(categories: string[]): string[] {
  const known = CATEGORY_ORDER.filter((c) => categories.includes(c));
  const rest = categories.filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...rest];
}

function previewOf(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function RecalledMemorySection() {
  const qc = useQueryClient();
  const [quickAddText, setQuickAddText] = useState('');
  const [quickAddCategory, setQuickAddCategory] = useState('auto');

  const memoriesQuery = useQuery<AutoMemoryListResponse>({
    queryKey: ['recalled-memory-auto'],
    queryFn: () => api.get<AutoMemoryListResponse>('/api/memory/auto'),
    refetchInterval: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/memory/auto/${id}`),
    onSuccess: () => {
      toast.success('Memory deleted');
      void qc.invalidateQueries({ queryKey: ['recalled-memory-auto'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });

  const createMutation = useMutation({
    mutationFn: (body: { key: string; content: string; category: string }) =>
      api.post('/api/memory/auto', body),
    onSuccess: () => {
      setQuickAddText('');
      toast.success('Memory added');
      void qc.invalidateQueries({ queryKey: ['recalled-memory-auto'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Add failed'),
  });

  const grouped = memoriesQuery.data?.grouped ?? {};
  const categories = useMemo(() => orderCategories(Object.keys(grouped)), [grouped]);
  const totalCount = memoriesQuery.data?.items.length ?? 0;

  const handleQuickAdd = () => {
    const text = quickAddText.trim();
    if (!text) return;
    // Quick-add rows are keyed by a timestamp so repeated adds never collide.
    const key = `quick_${Date.now()}`;
    createMutation.mutate({ key, content: text, category: quickAddCategory });
  };

  return (
    <SettingsSectionShell
      title="Recalled Memory"
      subtitle="Auto-memories August recalls into chat context. Browse by category, and add or remove entries directly."
      className="h-full"
      bodyClassName="px-0 pb-0 flex flex-col"
    >
      <div className="flex-1 overflow-auto px-6 pb-4 space-y-5">
        {memoriesQuery.isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : totalCount === 0 ? (
          <div className="rounded-xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
            <BrainCircuit className="mx-auto mb-2 size-6 text-muted-foreground/60" />
            No auto-memories yet. August saves these automatically as it learns, or add one below.
          </div>
        ) : (
          categories.map((category) => {
            const rows = grouped[category] ?? [];
            return (
              <div key={category} className="space-y-1.5">
                <div className="flex items-center gap-2 px-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {categoryLabel(category)}
                  </h3>
                  <span className="text-[10px] text-muted-foreground/60">{rows.length}</span>
                </div>
                <div className="rounded-lg border border-border/70 bg-card/40 divide-y divide-border/50 overflow-hidden">
                  {rows.map((row) => (
                    <div
                      key={row.id}
                      className="group/mem-row flex items-start gap-3 px-3 py-2.5 hover:bg-muted/30 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground truncate">{row.key}</div>
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1 break-words">
                          {previewOf(row.content)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 pt-0.5">
                        <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap">
                          {row.updatedAt ? `Updated ${formatTimeAgo(row.updatedAt)}` : ''}
                        </span>
                        <button
                          type="button"
                          title="Delete memory"
                          className={cn(
                            'p-1 rounded text-muted-foreground/0 transition-colors',
                            'group-hover/mem-row:text-muted-foreground hover:!text-danger',
                          )}
                          disabled={deleteMutation.isPending}
                          onClick={() => {
                            if (confirm(`Delete memory "${row.key}"?`)) {
                              deleteMutation.mutate(row.id);
                            }
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Bottom-pinned quick-add */}
      <div className="shrink-0 border-t border-border/60 bg-background/80 px-6 py-3">
        <div className="flex items-center gap-2">
          <select
            className="h-9 rounded-md border border-border bg-muted/30 px-2 text-xs text-foreground"
            value={quickAddCategory}
            onChange={(e) => setQuickAddCategory(e.target.value)}
          >
            {orderCategories([...new Set([...CATEGORY_ORDER, ...categories])]).map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Add a memory…"
            className="h-9 flex-1 rounded-md border border-border bg-muted/30 px-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
            value={quickAddText}
            onChange={(e) => setQuickAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleQuickAdd();
            }}
          />
          <button
            type="button"
            className="flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
            onClick={handleQuickAdd}
            disabled={createMutation.isPending || !quickAddText.trim()}
          >
            {createMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Add
          </button>
        </div>
      </div>
    </SettingsSectionShell>
  );
}
