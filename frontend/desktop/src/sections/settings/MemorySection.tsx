/* ── Memory — human-readable browse of what August stores ────────────── */
/* Renders the brain SQLite stores as titled entry cards (not a raw table),
 * grouped by category for facts, with a detail view (Markdown body, delete,
 * inline edit over whitelisted fields), a Claude-style add-box, the two
 * model-memory toggles, and per-entry / per-store Markdown export.
 *
 * The Memory hub splits the stores into four sub-tabs; the active section id
 * picks the store scope. Counts come from /api/brain/stores, rows from
 * /api/brain/stores/{name}. Writes go to /api/memory/manage (add-box) and
 * /api/brain/stores/{name}/{id} (edit/delete). Heuristics + auto-memories are
 * legacy read-only stores — they render with a Legacy badge and no mutations. */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Brain, ChevronLeft, ChevronRight, Download, FileUp, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import { PageLoader } from '@/components/PageLoader';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { cn, timeAgo } from '@/lib/utils';
import { ImportMemoryDialog } from './ImportMemoryDialog';

type Row = Record<string, unknown>;

interface StoreInfo {
  name: string;
  label: string;
  count: number;
}

interface StorePage {
  store?: string;
  label?: string;
  rows: Row[];
  total: number;
  limit: number;
  offset: number;
  error?: string;
}

interface BrainConfigResponse {
  source?: string;
  config?: { modelMemoryWrites?: boolean; memorySensitiveTopics?: boolean } & Record<string, unknown>;
  defaults?: Record<string, unknown>;
}

/** Store scope per Memory-hub sub-tab (section id → stores shown). Ids are
 *  immutable (settings-registry audit) — only the blurbs change. */
const SCOPES: Record<string, { title: string; blurb: string; stores: string[] }> = {
  'memory-knowledge': {
    title: 'Memories',
    blurb: 'KV notes plus legacy auto-memories (read-only).',
    stores: ['autoMemories', 'memory'],
  },
  'memory-facts': {
    title: 'Facts & Rules',
    blurb: 'Structured facts August extracted and the behavioral rules it learned.',
    stores: ['facts', 'heuristics'],
  },
  'memory-timeline': {
    title: 'Timeline',
    blurb: 'Episodic record of what August did, plus inter-agent blackboard notes.',
    stores: ['timeline', 'blackboard'],
  },
  'memory-sessions': {
    title: 'Sessions',
    blurb: 'Raw conversation sessions, chat messages, and exam records as stored.',
    stores: ['sessions', 'messages', 'exams', 'examAttempts'],
  },
};

/** Per-store rendering + mutation metadata. `idField` is the row identifier
 *  (the KV memory store keys by `key`; everything else by `id`). `editable`
 *  mirrors the backend field whitelist in memory_store/brain.py; `deletable`
 *  mirrors _ROW_DELETABLE there — stores without it reject DELETE, so the
 *  button must not render. */
interface StoreMeta {
  idField: string;
  title: (r: Row) => string;
  summary: (r: Row) => string;
  details?: (r: Row) => string | undefined;
  category?: (r: Row) => string;
  source?: (r: Row) => string;
  updated?: (r: Row) => string;
  legacy?: boolean;
  readOnly?: boolean;
  editable?: string[];
  deletable?: boolean;
  groupByCategory?: boolean;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** facts.fact_value is stored as JSON; the remember tool writes
 *  {"fact","details"} when details are present. Unwrap for display. */
function parseFactValue(raw: unknown): { summary: string; details?: string } {
  const s = str(raw);
  try {
    const obj = JSON.parse(s) as unknown;
    if (obj && typeof obj === 'object' && typeof (obj as Row).fact === 'string') {
      const o = obj as Row;
      return {
        summary: str(o.fact),
        details: typeof o.details === 'string' ? o.details : undefined,
      };
    }
    return { summary: s };
  } catch {
    return { summary: s };
  }
}

const STORE_META: Record<string, StoreMeta> = {
  facts: {
    idField: 'id',
    title: (r) => str(r.fact_key),
    summary: (r) => parseFactValue(r.fact_value).summary,
    details: (r) => parseFactValue(r.fact_value).details,
    category: (r) => str(r.category),
    source: (r) => str(r.source),
    updated: (r) => str(r.updated_at),
    editable: ['fact_value', 'category', 'confidence', 'expires_at'],
    deletable: true,
    groupByCategory: true,
  },
  memory: {
    idField: 'key',
    title: (r) => str(r.key),
    summary: (r) => str(r.value),
    updated: (r) => str(r.updated_at),
    editable: ['value'],
    deletable: true,
  },
  autoMemories: {
    idField: 'id',
    title: (r) => str(r.key),
    summary: (r) => str(r.content),
    category: (r) => str(r.category),
    updated: (r) => str(r.created_at),
    legacy: true,
    readOnly: true,
  },
  heuristics: {
    idField: 'id',
    title: (r) => str(r.rule),
    summary: (r) => str(r.source),
    category: (r) => str(r.category),
    updated: (r) => str(r.updated_at),
    legacy: true,
    readOnly: true,
  },
  timeline: {
    idField: 'id',
    title: (r) => str(r.event_summary),
    summary: (r) => str(r.session_id),
    category: (r) => str(r.category),
    updated: (r) => str(r.timestamp),
    editable: ['event_summary', 'category'],
    deletable: true,
  },
  blackboard: {
    idField: 'id',
    title: (r) => str(r.key),
    summary: (r) => str(r.value),
    source: (r) => str(r.agent),
    updated: (r) => str(r.created_at),
  },
  sessions: {
    idField: 'id',
    title: (r) => str(r.title) || str(r.id),
    summary: (r) => str(r.model),
    updated: (r) => str(r.started_at),
  },
  messages: {
    idField: 'id',
    title: (r) => str(r.role),
    summary: (r) => str(r.content),
    updated: (r) => str(r.created_at),
  },
  exams: {
    idField: 'id',
    title: (r) => str(r.title),
    summary: (r) => str(r.topic),
    updated: (r) => str(r.created_at),
  },
  examAttempts: {
    idField: 'id',
    title: (r) => str(r.exam_id),
    summary: (r) => (r.is_correct ? 'answered correctly' : 'answered'),
    updated: (r) => str(r.answered_at),
  },
};

/** Claude-style category headers for grouped facts. */
const CATEGORY_LABELS: Record<string, string> = {
  user: 'You',
  feedback: 'Feedback',
  project: 'Projects',
  reference: 'References',
  general: 'General',
};
const CATEGORY_ORDER = ['user', 'feedback', 'project', 'reference', 'general'];

const PAGE_SIZE = 25;
const LONG_TEXT_FIELDS = new Set(['fact_value', 'value', 'event_summary', 'rule']);

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'note'
  );
}

function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function entryToMarkdown(store: string, r: Row, meta: StoreMeta): string {
  const title = meta.title(r) || '(untitled)';
  const summary = meta.summary(r);
  const details = meta.details?.(r) ?? '';
  const category = meta.category?.(r) ?? '';
  const updated = meta.updated?.(r) ?? '';
  const lines = [
    '---',
    `name: ${title}`,
    `description: ${summary.split('\n')[0].slice(0, 120)}`,
    `type: ${category || store}`,
    updated ? `updated: ${updated}` : '',
    '---',
    '',
    summary,
  ].filter((l) => l !== '');
  if (details) lines.push('', details);
  return lines.join('\n');
}

export function MemorySection({ active }: { active: { id: string } }) {
  const scope = SCOPES[active.id];
  const qc = useQueryClient();
  const { state: confirmState, confirm, handleConfirm, handleCancel } = useConfirmDialog();

  const [activeStore, setActiveStore] = useState<string>(scope?.stores[0] ?? 'facts');
  const [mode, setMode] = useState<'list' | 'detail'>('list');
  const [selected, setSelected] = useState<Row | null>(null);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [addText, setAddText] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const query = search.trim();

  // Switching sub-tabs resets the browse state to that scope's first store.
  useEffect(() => {
    setActiveStore(scope?.stores[0] ?? 'facts');
    setMode('list');
    setSelected(null);
    setEditing(false);
    setOffset(0);
    setSearch('');
  }, [active.id, scope]);

  const storesQ = useQuery<{ stores: StoreInfo[] }>({
    queryKey: ['brain-stores'],
    queryFn: () => api.get<{ stores: StoreInfo[] }>('/api/brain/stores'),
  });
  const configQ = useQuery<BrainConfigResponse>({
    queryKey: ['brain-config'],
    queryFn: () => api.get<BrainConfigResponse>('/api/brain/config'),
  });
  const pageQ = useQuery<StorePage>({
    queryKey: ['brain-store', activeStore, offset, query],
    queryFn: () =>
      api.get<StorePage>(
        `/api/brain/stores/${encodeURIComponent(activeStore)}` +
          `?limit=${PAGE_SIZE}&offset=${offset}&query=${encodeURIComponent(query)}`,
      ),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['brain-stores'] });
    void qc.invalidateQueries({ queryKey: ['brain-store'] });
  };

  const configMut = useMutation({
    mutationFn: (patch: Record<string, boolean>) => api.put('/api/brain/config', patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['brain-config'] }),
    onError: (e: Error) => toast.error(e.message || 'Could not update setting'),
  });
  const addMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/api/memory/manage', body),
    onSuccess: () => {
      invalidate();
      setAddText('');
      toast.success('Memory saved');
    },
    onError: (e: Error) => toast.error(e.message || 'Could not save memory'),
  });
  const deleteMut = useMutation({
    mutationFn: (p: { store: string; id: string }) =>
      api.delete(`/api/brain/stores/${encodeURIComponent(p.store)}/${encodeURIComponent(p.id)}`),
    onSuccess: () => {
      invalidate();
      setMode('list');
      setSelected(null);
      toast.success('Entry deleted');
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });
  const editMut = useMutation({
    mutationFn: (p: { store: string; id: string; patch: Record<string, unknown> }) =>
      api.patch<{ row?: Row }>(
        `/api/brain/stores/${encodeURIComponent(p.store)}/${encodeURIComponent(p.id)}`,
        p.patch,
      ),
    onSuccess: (res: { row?: Row }) => {
      invalidate();
      setEditing(false);
      if (res?.row) setSelected(res.row);
      toast.success('Entry updated');
    },
    onError: (e: Error) => toast.error(e.message || 'Update failed'),
  });

  const meta = STORE_META[activeStore];
  const stores = useMemo(() => {
    const all = storesQ.data?.stores ?? [];
    if (!scope) return all;
    return all
      .filter((s) => scope.stores.includes(s.name))
      .sort((a, b) => scope.stores.indexOf(a.name) - scope.stores.indexOf(b.name));
  }, [storesQ.data, scope]);

  const rows = pageQ.data?.rows ?? [];
  const total = pageQ.data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const title = scope?.title ?? 'Memory';
  const showAddBox = active.id === 'memory-knowledge' || active.id === 'memory-facts';

  // Group facts under category headers; other stores render flat.
  const groups = useMemo(() => {
    if (!meta?.groupByCategory) return null;
    const byCat = new Map<string, Row[]>();
    for (const r of rows) {
      const cat = (meta.category?.(r) || 'general').toLowerCase();
      const list = byCat.get(cat) ?? [];
      list.push(r);
      byCat.set(cat, list);
    }
    const ordered: Array<{ cat: string; label: string; rows: Row[] }> = [];
    for (const cat of CATEGORY_ORDER) {
      if (byCat.has(cat)) ordered.push({ cat, label: CATEGORY_LABELS[cat] ?? cat, rows: byCat.get(cat)! });
    }
    for (const [cat, list] of byCat) {
      if (!CATEGORY_ORDER.includes(cat)) ordered.push({ cat, label: CATEGORY_LABELS[cat] ?? cat, rows: list });
    }
    return ordered;
  }, [rows, meta]);

  const openDetail = (r: Row) => {
    setSelected(r);
    setEditing(false);
    setMode('detail');
  };

  const startEdit = () => {
    if (!selected || !meta?.editable) return;
    const draft: Record<string, string> = {};
    for (const f of meta.editable) draft[f] = str(selected[f]);
    setEditDraft(draft);
    setEditing(true);
  };

  const saveEdit = () => {
    if (!selected || !meta) return;
    const id = str(selected[meta.idField]);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(editDraft)) {
      patch[k] = k === 'confidence' ? Number(v || 0) : v;
    }
    editMut.mutate({ store: activeStore, id, patch });
  };

  const requestDelete = () => {
    if (!selected || !meta) return;
    const id = str(selected[meta.idField]);
    const name = meta.title(selected) || id;
    void confirm({
      title: 'Delete this entry?',
      message: `“${name}” will be removed from ${activeStore}. This cannot be undone from here.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    }).then((ok) => {
      if (ok) deleteMut.mutate({ store: activeStore, id });
    });
  };

  const exportEntry = () => {
    if (!selected || !meta) return;
    downloadMarkdown(`${slugify(meta.title(selected))}.md`, entryToMarkdown(activeStore, selected, meta));
  };

  const exportStore = () => {
    if (!meta || rows.length === 0) return;
    const body = rows.map((r) => entryToMarkdown(activeStore, r, meta)).join('\n\n---\n\n');
    downloadMarkdown(`${activeStore}-export.md`, body);
  };

  const addMemory = () => {
    const text = addText.trim();
    if (!text) return;
    addMut.mutate({ action: 'set', key: `user:${slugify(text)}`, value: text, category: 'general', source: 'user' });
  };

  const cfg = configQ.data?.config;

  return (
    <div className="px-8 py-6 max-w-4xl space-y-5">
      <div className="flex items-center gap-3">
        <Brain className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">
            {scope?.blurb ?? 'Everything August has learned and recorded, store by store.'}
          </p>
        </div>
      </div>

      {/* Model-memory toggles (Claude parity) */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-2 space-y-1">
        <SettingsToggle
          checked={Boolean(cfg?.modelMemoryWrites)}
          onCheckedChange={(next) => configMut.mutate({ modelMemoryWrites: next })}
          label="Model can save memories"
          description="Lets August persist durable facts it learns while you chat (the remember tool)."
          disabled={configQ.isLoading || configMut.isPending}
          data-testid="memory-model-writes-toggle"
        />
        <SettingsToggle
          checked={Boolean(cfg?.memorySensitiveTopics)}
          onCheckedChange={(next) => configMut.mutate({ memorySensitiveTopics: next })}
          label="Include sensitive topics in memory"
          description="Allow saving health, ID numbers, minors, or beliefs. Off by default."
          disabled={configQ.isLoading || configMut.isPending}
          data-testid="memory-sensitive-toggle"
        />
      </div>

      {storesQ.isLoading ? (
        <PageLoader label="Loading memory stores…" variant="card" className="py-10" />
      ) : (
        <>
          {/* Store chips */}
          <div className="flex flex-wrap gap-2">
            {stores.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => {
                  setActiveStore(s.name);
                  setOffset(0);
                  setMode('list');
                  setSelected(null);
                }}
                title={s.label}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition',
                  s.name === activeStore
                    ? 'border-primary/50 bg-primary/10 text-foreground'
                    : 'border-border/60 bg-card/60 text-muted-foreground hover:border-primary/30 hover:text-foreground',
                )}
              >
                <span className="font-medium">{s.name}</span>
                <span className="rounded bg-muted/60 px-1 text-[10px] tabular-nums">{s.count}</span>
              </button>
            ))}
          </div>

          {/* Search + refresh + export-store */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOffset(0);
                }}
                placeholder={`Search ${activeStore}…`}
                className="w-full rounded-lg border border-border/60 bg-card/60 py-1.5 pl-8 pr-3 text-xs text-foreground outline-none transition focus:border-primary/40"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                void storesQ.refetch();
                void pageQ.refetch();
              }}
              title="Refresh"
              className="rounded-lg border border-border/60 bg-card/60 p-1.5 text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
            >
              <RefreshCw className={cn('size-3.5', pageQ.isFetching && 'animate-spin')} />
            </button>
            <button
              type="button"
              onClick={exportStore}
              disabled={rows.length === 0}
              title="Export this store as Markdown"
              className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-[11px] text-muted-foreground transition hover:border-primary/30 hover:text-foreground disabled:opacity-40"
            >
              <Download className="size-3.5" /> Export
            </button>
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              title="Import memory from another AI (Markdown or JSON export)"
              className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-[11px] text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
              data-testid="memory-import-open"
            >
              <FileUp className="size-3.5" /> Import
            </button>
          </div>

          {mode === 'detail' && selected && meta ? (
            <DetailView
              store={activeStore}
              row={selected}
              meta={meta}
              editing={editing}
              editDraft={editDraft}
              saving={editMut.isPending}
              onDraftChange={(k, v) => setEditDraft((d) => ({ ...d, [k]: v }))}
              onBack={() => {
                setMode('list');
                setSelected(null);
                setEditing(false);
              }}
              onStartEdit={startEdit}
              onSaveEdit={saveEdit}
              onCancelEdit={() => setEditing(false)}
              onDelete={requestDelete}
              onExport={exportEntry}
            />
          ) : (
            <>
              {/* Entry list */}
              <div className="space-y-4">
                {pageQ.isLoading ? (
                  <PageLoader label="Loading entries…" variant="card" className="py-8" />
                ) : pageQ.isError ? (
                  <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-6 text-center text-xs text-destructive">
                    Could not load {activeStore}:{' '}
                    {(pageQ.error as Error | null)?.message ?? 'unknown error'}
                  </div>
                ) : rows.length === 0 ? (
                  <p className="rounded-xl border border-white/[0.06] bg-card/60 px-4 py-6 text-center text-xs text-muted-foreground">
                    {query
                      ? `No ${activeStore} entries match “${query}”.`
                      : meta?.legacy
                        ? `Nothing stored in ${activeStore}. This is a legacy store — no new entries are written here.`
                        : `Nothing stored in ${activeStore} yet.`}
                  </p>
                ) : groups ? (
                  groups.map((g) => (
                    <div key={g.cat}>
                      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {g.label}
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {g.rows.map((r, i) => (
                          <EntryCard key={`${g.cat}-${i}`} row={r} meta={meta} onOpen={() => openDetail(r)} />
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {rows.map((r, i) => (
                      <EntryCard key={`row-${i}`} row={r} meta={meta} onOpen={() => openDetail(r)} />
                    ))}
                  </div>
                )}
              </div>

              {/* Add-box (Memories + Facts tabs) */}
              {showAddBox && (
                <div className="flex items-center gap-2">
                  <input
                    value={addText}
                    onChange={(e) => setAddText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addMemory();
                    }}
                    placeholder="Add a memory, e.g. “My plant is named Gerald”"
                    className="flex-1 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-xs text-foreground outline-none transition focus:border-primary/40"
                    data-testid="memory-add-input"
                  />
                  <button
                    type="button"
                    onClick={addMemory}
                    disabled={addMut.isPending || !addText.trim()}
                    className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
                    data-testid="memory-add-button"
                  >
                    <Plus className="size-3.5" /> Add
                  </button>
                </div>
              )}

              {/* Pagination */}
              {total > PAGE_SIZE && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {from}–{to} of {total}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                      className="rounded-md border border-border/60 p-1 transition enabled:hover:text-foreground disabled:opacity-40"
                      title="Previous page"
                    >
                      <ChevronLeft className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={offset + PAGE_SIZE >= total}
                      onClick={() => setOffset(offset + PAGE_SIZE)}
                      className="rounded-md border border-border/60 p-1 transition enabled:hover:text-foreground disabled:opacity-40"
                      title="Next page"
                    >
                      <ChevronRight className="size-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

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
      <ImportMemoryDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          void storesQ.refetch();
          void pageQ.refetch();
        }}
      />
    </div>
  );
}

/* ── Entry card ─────────────────────────────────────────────────────── */

function EntryCard({ row, meta, onOpen }: { row: Row; meta: StoreMeta; onOpen: () => void }) {
  const title = meta.title(row) || '(untitled)';
  const summary = meta.summary(row);
  const category = meta.category?.(row);
  const source = meta.source?.(row);
  const updated = meta.updated?.(row);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full rounded-xl border border-border/50 bg-card/50 p-4 text-left transition hover:border-border hover:bg-card/80 focus:outline-none focus:ring-1 focus:ring-primary/40"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-[11px] font-semibold uppercase text-primary">
          {title.slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-foreground">{title}</span>
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
            {summary || 'No content'}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {category && (
              <span className="rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                {category}
              </span>
            )}
            {source && (
              <span className="rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                {source}
              </span>
            )}
            {meta.legacy && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-400">
                legacy
              </span>
            )}
            {updated && <span className="ml-auto text-[10px] text-muted-foreground/70">{timeAgo(updated)}</span>}
          </div>
        </div>
      </div>
    </button>
  );
}

/* ── Detail view ────────────────────────────────────────────────────── */

function DetailView({
  store,
  row,
  meta,
  editing,
  editDraft,
  saving,
  onDraftChange,
  onBack,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onExport,
}: {
  store: string;
  row: Row;
  meta: StoreMeta;
  editing: boolean;
  editDraft: Record<string, string>;
  saving: boolean;
  onDraftChange: (key: string, value: string) => void;
  onBack: () => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const title = meta.title(row) || '(untitled)';
  const summary = meta.summary(row);
  const details = meta.details?.(row);
  const category = meta.category?.(row);
  const source = meta.source?.(row);
  const updated = meta.updated?.(row);
  const created = str(row.created_at);
  const confidence = str(row.confidence);

  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="mb-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" /> Back to {store}
          </button>
          <h2 className="truncate text-lg font-semibold text-foreground">{title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {category && (
              <span className="rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                {category}
              </span>
            )}
            {source && (
              <span className="rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                {source}
              </span>
            )}
            {meta.legacy && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-400">
                legacy · read-only
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!meta.readOnly && meta.editable && !editing && (
            <button
              type="button"
              onClick={onStartEdit}
              className="inline-flex items-center gap-1 rounded-lg border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
            >
              <Pencil className="size-3.5" /> Edit
            </button>
          )}
          <button
            type="button"
            onClick={onExport}
            className="inline-flex items-center gap-1 rounded-lg border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
          >
            <Download className="size-3.5" /> Export
          </button>
          {!meta.readOnly && meta.deletable && (
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex items-center gap-1 rounded-lg border border-destructive/40 px-2 py-1.5 text-[11px] text-destructive transition hover:bg-destructive/10"
            >
              <Trash2 className="size-3.5" /> Delete
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="space-y-3">
          {(meta.editable ?? []).map((f) => (
            <div key={f}>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {f}
              </label>
              {LONG_TEXT_FIELDS.has(f) ? (
                <textarea
                  value={editDraft[f] ?? ''}
                  onChange={(e) => onDraftChange(f, e.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-border/60 bg-background/40 p-2 text-xs text-foreground outline-none focus:border-primary/40"
                />
              ) : (
                <input
                  value={editDraft[f] ?? ''}
                  onChange={(e) => onDraftChange(f, e.target.value)}
                  className="w-full rounded-lg border border-border/60 bg-background/40 px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary/40"
                />
              )}
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancelEdit}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSaveEdit}
              disabled={saving}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-white/[0.06] bg-background/30 p-3">
            <Markdown content={summary || '_No content_'} />
            {details && (
              <div className="mt-3 border-t border-white/[0.06] pt-3">
                <Markdown content={details} />
              </div>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground/80">
            {[
              source ? `source: ${source}` : '',
              confidence ? `confidence: ${confidence}` : '',
              created ? `created: ${created}` : '',
              updated ? `updated: ${updated}` : '',
            ]
              .filter(Boolean)
              .join('  ·  ') || 'No provenance recorded.'}
          </p>
        </div>
      )}
    </div>
  );
}
