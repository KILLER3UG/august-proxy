/* ── Memory — human-readable browse of what August stores ────────────── */
/* Memories + Facts tabs render one flat chronological list across kinds
 * (plan §5.1): kind chip · title · relative date · ⋯, filter chips above
 * (not tabs), no cards/meters, and a one-line health footer fed by the
 * consolidation log. Timeline/Sessions stay raw-but-readable card grids.
 *
 * Detail view (Markdown body, delete, inline edit over whitelisted fields),
 * the Claude-style add-box, the two model-memory toggles, and per-entry /
 * per-store Markdown export are shared by both modes.
 *
 * Counts come from /api/brain/stores, rows from /api/brain/stores/{name}.
 * Writes go to /api/august/memory/manage (add-box) and
 * /api/brain/stores/{name}/{id} (edit/delete). Heuristics + auto-memories
 * are legacy read-only stores — they render with a Legacy badge and no
 * mutations. The footer's raw-state lookup (§5.5) is the only surface where
 * internal_state machine state is ever visible. */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Brain, ChevronLeft, ChevronRight, Download, FileUp, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
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
  config?: { modelMemoryRead?: boolean; modelMemoryWrites?: boolean; memorySensitiveTopics?: boolean } & Record<string, unknown>;
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

/** Tabs rendered as one flat chronological list across kinds (§5.1). */
const UNIFIED_TABS = new Set(['memory-knowledge', 'memory-facts']);

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

/* ── §5.1 flat-list kinds ──────────────────────────────────────────── */

type EntryKind = 'fact' | 'lesson' | 'pref' | 'note';

const KIND_META: Record<EntryKind, { label: string; className: string }> = {
  fact: { label: 'fact', className: 'border-sky-500/30 bg-sky-500/10 text-sky-400' },
  lesson: { label: 'lesson', className: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  pref: { label: 'pref', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  note: { label: 'note', className: 'border-border/60 bg-muted/30 text-muted-foreground' },
};

const KIND_ORDER: EntryKind[] = ['fact', 'lesson', 'pref', 'note'];

/** Kind chip for a row: heuristics are lessons, user-category facts are
 *  prefs, everything in the KV/legacy note stores is a note. */
function deriveKind(store: string, r: Row): EntryKind {
  if (store === 'heuristics') return 'lesson';
  if (store === 'facts') return str(r.category).toLowerCase() === 'user' ? 'pref' : 'fact';
  return 'note';
}

function hasExpiry(r: Row): boolean {
  return str(r.expires_at).trim() !== '';
}

function sortTime(r: Row, meta: StoreMeta | undefined): number {
  const t = Date.parse(meta?.updated?.(r) ?? '');
  return Number.isFinite(t) ? t : 0;
}

interface FlatEntry {
  store: string;
  row: Row;
  id: string;
  kind: EntryKind;
  title: string;
  summary: string;
  updated: string;
  expiring: boolean;
  legacy: boolean;
}

const PAGE_SIZE = 25;
const UNIFIED_FETCH = 200;
const UNIFIED_RENDER = 50;
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
  const unified = UNIFIED_TABS.has(active.id);
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
  const [kindFilter, setKindFilter] = useState<'all' | EntryKind | 'expiring'>('all');
  const [unifiedShown, setUnifiedShown] = useState(UNIFIED_RENDER);
  const query = search.trim();

  // Switching sub-tabs resets the browse state to that scope's first store.
  useEffect(() => {
    setActiveStore(scope?.stores[0] ?? 'facts');
    setMode('list');
    setSelected(null);
    setEditing(false);
    setOffset(0);
    setSearch('');
    setKindFilter('all');
    setUnifiedShown(UNIFIED_RENDER);
  }, [active.id, scope]);

  const storesQ = useQuery<{ stores: StoreInfo[] }>({
    queryKey: ['brain-stores'],
    queryFn: () => api.get<{ stores: StoreInfo[] }>('/api/brain/stores'),
  });
  const configQ = useQuery<BrainConfigResponse>({
    queryKey: ['brain-config'],
    queryFn: () => api.get<BrainConfigResponse>('/api/brain/config'),
  });
  // Non-unified tabs page one store at a time.
  const pageQ = useQuery<StorePage>({
    queryKey: ['brain-store', activeStore, offset, query],
    queryFn: () =>
      api.get<StorePage>(
        `/api/brain/stores/${encodeURIComponent(activeStore)}` +
          `?limit=${PAGE_SIZE}&offset=${offset}&query=${encodeURIComponent(query)}`,
      ),
    enabled: !unified,
  });
  // Unified tabs fetch both scope stores and merge client-side (§5.1).
  const unifiedStoreA = unified ? scope.stores[0] : '';
  const unifiedStoreB = unified ? (scope.stores[1] ?? '') : '';
  const unifiedQa = useQuery<StorePage>({
    queryKey: ['brain-store', unifiedStoreA, 0, query, UNIFIED_FETCH],
    queryFn: () =>
      api.get<StorePage>(
        `/api/brain/stores/${encodeURIComponent(unifiedStoreA)}` +
          `?limit=${UNIFIED_FETCH}&offset=0&query=${encodeURIComponent(query)}`,
      ),
    enabled: unified && !!unifiedStoreA,
  });
  const unifiedQb = useQuery<StorePage>({
    queryKey: ['brain-store', unifiedStoreB, 0, query, UNIFIED_FETCH],
    queryFn: () =>
      api.get<StorePage>(
        `/api/brain/stores/${encodeURIComponent(unifiedStoreB)}` +
          `?limit=${UNIFIED_FETCH}&offset=0&query=${encodeURIComponent(query)}`,
      ),
    enabled: unified && !!unifiedStoreB,
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
    // The manage route lives on the august router (/api/august prefix) —
    // posting to /api/memory/manage 404s (plan §5.1 step zero).
    mutationFn: (body: Record<string, unknown>) => api.post('/api/august/memory/manage', body),
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
  const consolidateMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; summary?: Record<string, unknown> }>('/api/brain/consolidation/run', {}),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['consolidation-log'] });
      toast.success('Consolidation pass complete');
    },
    onError: (e: Error) => toast.error(e.message || 'Consolidation failed'),
  });

  const meta = STORE_META[activeStore];
  const stores = useMemo(() => {
    const all = storesQ.data?.stores ?? [];
    if (!scope) return all;
    return all
      .filter((s) => scope.stores.includes(s.name))
      .sort((a, b) => scope.stores.indexOf(a.name) - scope.stores.indexOf(b.name));
  }, [storesQ.data, scope]);

  /* §5.1: merge both scope stores into one flat chronological list. */
  const flatEntries = useMemo<FlatEntry[]>(() => {
    if (!unified || !scope) return [];
    const pages: Array<[string, StorePage | undefined]> = [
      [unifiedStoreA, unifiedQa.data],
      [unifiedStoreB, unifiedQb.data],
    ];
    const out: FlatEntry[] = [];
    for (const [store, page] of pages) {
      if (!store) continue;
      const m = STORE_META[store];
      for (const row of page?.rows ?? []) {
        // Facts read human-first in the flat list: the fact text, not the
        // slug-like fact_key, is the row title (key stays the detail header).
        const baseTitle = m?.title(row) || '(untitled)';
        const title =
          store === 'facts' ? parseFactValue(row.fact_value).summary || baseTitle : baseTitle;
        out.push({
          store,
          row,
          id: str(row[m?.idField ?? 'id']),
          kind: deriveKind(store, row),
          title,
          summary: m?.summary(row) ?? '',
          updated: m?.updated?.(row) ?? '',
          expiring: hasExpiry(row),
          legacy: !!m?.legacy,
        });
      }
    }
    out.sort((a, b) => sortTime(b.row, STORE_META[b.store]) - sortTime(a.row, STORE_META[a.store]));
    return out;
  }, [unified, scope, unifiedStoreA, unifiedStoreB, unifiedQa.data, unifiedQb.data]);

  const kindCounts = useMemo(() => {
    const counts: Record<'all' | EntryKind | 'expiring', number> = {
      all: flatEntries.length,
      fact: 0,
      lesson: 0,
      pref: 0,
      note: 0,
      expiring: 0,
    };
    for (const e of flatEntries) {
      counts[e.kind] += 1;
      if (e.expiring) counts.expiring += 1;
    }
    return counts;
  }, [flatEntries]);

  const filteredEntries = useMemo(() => {
    if (kindFilter === 'all') return flatEntries;
    if (kindFilter === 'expiring') return flatEntries.filter((e) => e.expiring);
    return flatEntries.filter((e) => e.kind === kindFilter);
  }, [flatEntries, kindFilter]);

  const rows = pageQ.data?.rows ?? [];
  const total = pageQ.data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const title = scope?.title ?? 'Memory';
  const showAddBox = active.id === 'memory-knowledge' || active.id === 'memory-facts';

  const openDetail = (r: Row, store?: string) => {
    if (store) setActiveStore(store);
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

  const requestDelete = (rowOverride?: Row, storeOverride?: string) => {
    const row = rowOverride ?? selected;
    const store = storeOverride ?? activeStore;
    const m = STORE_META[store];
    if (!row || !m) return;
    const id = str(row[m.idField]);
    const name = m.title(row) || id;
    void confirm({
      title: 'Delete this entry?',
      message: `“${name}” will be removed from ${store}. This cannot be undone from here.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    }).then((ok) => {
      if (ok) deleteMut.mutate({ store, id });
    });
  };

  const exportEntry = (rowOverride?: Row, storeOverride?: string) => {
    const row = rowOverride ?? selected;
    const store = storeOverride ?? activeStore;
    const m = STORE_META[store];
    if (!row || !m) return;
    downloadMarkdown(`${slugify(m.title(row))}.md`, entryToMarkdown(store, row, m));
  };

  const exportStore = () => {
    if (unified) {
      if (flatEntries.length === 0) return;
      const body = flatEntries
        .map((e) => entryToMarkdown(e.store, e.row, STORE_META[e.store]))
        .join('\n\n---\n\n');
      downloadMarkdown(`${scope?.title ?? 'memory'}-export.md`.toLowerCase().replace(/\s+/g, '-'), body);
      return;
    }
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
  const unifiedLoading = unified && (unifiedQa.isLoading || (!!unifiedStoreB && unifiedQb.isLoading));
  const unifiedError = unified && ((unifiedQa.isError && unifiedQa.error) || (unifiedQb.isError && unifiedQb.error));

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
          checked={Boolean(cfg?.modelMemoryRead ?? true)}
          onCheckedChange={(next) => configMut.mutate({ modelMemoryRead: next })}
          label="Model can read memories"
          description="Injects stored facts into each turn. Off stops the auto-injection; explicit lookups still work."
          disabled={configQ.isLoading || configMut.isPending}
          data-testid="memory-model-read-toggle"
        />
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
          {/* Store chips — raw tabs only; the unified list uses kind chips. */}
          {!unified && (
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
          )}

          {/* Search + refresh + export-store */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOffset(0);
                  setUnifiedShown(UNIFIED_RENDER);
                }}
                placeholder="Search memory…"
                className="w-full rounded-lg border border-border/60 bg-card/60 py-1.5 pl-8 pr-3 text-xs text-foreground outline-none transition focus:border-primary/40"
                data-testid="memory-search-input"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                void storesQ.refetch();
                void pageQ.refetch();
                void unifiedQa.refetch();
                void unifiedQb.refetch();
              }}
              title="Refresh"
              className="rounded-lg border border-border/60 bg-card/60 p-1.5 text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
            >
              <RefreshCw className={cn('size-3.5', (pageQ.isFetching || unifiedQa.isFetching || unifiedQb.isFetching) && 'animate-spin')} />
            </button>
            <button
              type="button"
              onClick={exportStore}
              disabled={unified ? flatEntries.length === 0 : rows.length === 0}
              title="Export as Markdown"
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
              onDelete={() => requestDelete()}
              onExport={() => exportEntry()}
            />
          ) : unified ? (
            <>
              {/* §5.1 filter chips — above the list, not tabs. */}
              <div className="flex flex-wrap items-center gap-1.5" data-testid="memory-kind-chips">
                <KindChip
                  label="all"
                  count={kindCounts.all}
                  active={kindFilter === 'all'}
                  onClick={() => setKindFilter('all')}
                />
                {KIND_ORDER.filter((k) => kindCounts[k] > 0).map((k) => (
                  <KindChip
                    key={k}
                    label={KIND_META[k].label}
                    count={kindCounts[k]}
                    active={kindFilter === k}
                    onClick={() => setKindFilter(k)}
                  />
                ))}
                {kindCounts.expiring > 0 && (
                  <KindChip
                    label="expiring"
                    count={kindCounts.expiring}
                    active={kindFilter === 'expiring'}
                    onClick={() => setKindFilter('expiring')}
                  />
                )}
              </div>

              {unifiedLoading ? (
                <PageLoader label="Loading entries…" variant="card" className="py-8" />
              ) : unifiedError ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-6 text-center text-xs text-destructive">
                  Could not load memory: {(unifiedError as Error | null)?.message ?? 'unknown error'}
                </div>
              ) : filteredEntries.length === 0 ? (
                <p className="rounded-xl border border-white/[0.06] bg-card/60 px-4 py-6 text-center text-xs text-muted-foreground">
                  {query
                    ? `No entries match “${query}”.`
                    : kindFilter !== 'all'
                      ? `No ${kindFilter} entries.`
                      : 'Nothing stored here yet.'}
                </p>
              ) : (
                <div className="divide-y divide-white/[0.04]" data-testid="memory-flat-list">
                  {filteredEntries.slice(0, unifiedShown).map((e) => (
                    <FlatEntryRow
                      key={`${e.store}:${e.id}`}
                      entry={e}
                      onView={() => openDetail(e.row, e.store)}
                      onEdit={() => {
                        openDetail(e.row, e.store);
                        const m = STORE_META[e.store];
                        if (m?.editable) {
                          const draft: Record<string, string> = {};
                          for (const f of m.editable) draft[f] = str(e.row[f]);
                          setEditDraft(draft);
                          setEditing(true);
                        }
                      }}
                      onDelete={() => requestDelete(e.row, e.store)}
                      onExport={() => exportEntry(e.row, e.store)}
                    />
                  ))}
                  {filteredEntries.length > unifiedShown && (
                    <button
                      type="button"
                      onClick={() => setUnifiedShown((n) => n + UNIFIED_RENDER)}
                      className="w-full py-2 text-center text-[11px] text-muted-foreground transition hover:text-foreground"
                      data-testid="memory-show-more"
                    >
                      +{filteredEntries.length - unifiedShown} more
                    </button>
                  )}
                </div>
              )}

              {/* §5.1 health footer — the §3.5 audit surface. */}
              <HealthFooter
                consolidating={consolidateMut.isPending}
                onRunNow={() => consolidateMut.mutate()}
              />
            </>
          ) : (
            <>
              {/* Entry list (raw-but-readable tabs: Timeline, Sessions) */}
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
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {rows.map((r, i) => (
                      <EntryCard key={`row-${i}`} row={r} meta={meta} onOpen={() => openDetail(r)} />
                    ))}
                  </div>
                )}
              </div>

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

      {/* §5.5 raw state lookup — the only surface where internal_state
          machine state is ever visible. */}
      <RawStateLookup />

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
          void unifiedQa.refetch();
          void unifiedQb.refetch();
        }}
      />
    </div>
  );
}

/* ── §5.1 kind chip ────────────────────────────────────────────────── */

function KindChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10.5px] transition',
        active
          ? 'border-primary/50 bg-primary/10 text-foreground'
          : 'border-border/60 bg-card/40 text-muted-foreground hover:border-primary/30 hover:text-foreground',
      )}
      data-testid={`memory-kind-chip-${label}`}
    >
      {label}
      <span className="tabular-nums text-[9.5px] opacity-70">{count}</span>
    </button>
  );
}

/* ── §5.1 flat row: kind chip · "title" · relative date · ⋯ ─────────── */

function FlatEntryRow({
  entry,
  onView,
  onEdit,
  onDelete,
  onExport,
}: {
  entry: FlatEntry;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const meta = STORE_META[entry.store];
  const canEdit = !!meta?.editable && !meta?.readOnly;
  const canDelete = !!meta?.deletable && !meta?.readOnly;
  const kind = KIND_META[entry.kind];

  return (
    <div
      className="group relative flex items-center gap-2.5 py-2"
      data-testid="memory-flat-row"
      data-kind={entry.kind}
    >
      <span
        className={cn(
          'w-14 shrink-0 rounded-md border px-1 py-0.5 text-center text-[9px] font-medium uppercase tracking-wide',
          kind.className,
        )}
        data-testid="memory-kind-label"
      >
        {kind.label}
      </span>
      <button
        type="button"
        onClick={onView}
        className="min-w-0 flex-1 text-left"
        title={entry.summary || entry.title}
      >
        <span className="block truncate text-[12.5px] text-foreground/90">
          “{entry.title}”
        </span>
      </button>
      {entry.legacy && (
        <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[8.5px] font-medium uppercase text-amber-400">
          legacy
        </span>
      )}
      {entry.expiring && (
        <span
          className="shrink-0 rounded border border-warning/30 bg-warning/10 px-1 py-0.5 text-[8.5px] font-medium uppercase text-warning"
          title={`Expires: ${str(entry.row.expires_at)}`}
        >
          expiring
        </span>
      )}
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
        {timeAgo(entry.updated)}
      </span>
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="rounded p-0.5 text-muted-foreground/40 transition hover:bg-white/[0.05] hover:text-foreground"
          aria-label="Entry actions"
          aria-expanded={menuOpen}
          data-testid="memory-row-menu"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
        {menuOpen && (
          <RowMenu
            canEdit={canEdit}
            canDelete={canDelete}
            onView={() => {
              setMenuOpen(false);
              onView();
            }}
            onEdit={() => {
              setMenuOpen(false);
              onEdit();
            }}
            onDelete={() => {
              setMenuOpen(false);
              onDelete();
            }}
            onExport={() => {
              setMenuOpen(false);
              onExport();
            }}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function RowMenu({
  canEdit,
  canDelete,
  onView,
  onEdit,
  onDelete,
  onExport,
  onClose,
}: {
  canEdit: boolean;
  canDelete: boolean;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el?.closest('[data-slot="memory-row-menu-pop"]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const item =
    'w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-foreground/90 transition';

  return (
    <div
      role="menu"
      data-slot="memory-row-menu-pop"
      className="absolute right-0 top-6 z-50 w-32 rounded-md border border-border/50 bg-popover py-1 text-xs shadow-2xl"
    >
      <button type="button" role="menuitem" onClick={onView} className={item}>
        View
      </button>
      {canEdit && (
        <button type="button" role="menuitem" onClick={onEdit} className={item}>
          <Pencil className="size-3 text-muted-foreground" /> Edit
        </button>
      )}
      <button type="button" role="menuitem" onClick={onExport} className={item}>
        <Download className="size-3 text-muted-foreground" /> Export
      </button>
      {canDelete && (
        <>
          <div className="my-1 h-px bg-border/40" />
          <button
            type="button"
            role="menuitem"
            onClick={onDelete}
            className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-destructive transition"
          >
            <Trash2 className="size-3" /> Delete
          </button>
        </>
      )}
    </div>
  );
}

/* ── §5.1 health footer (the §3.5 audit surface) ───────────────────── */

interface ConsolidationLogResponse {
  entries: Array<{ createdAt: string; eventType: string; detail: Record<string, unknown> }>;
}

function HealthFooter({
  consolidating,
  onRunNow,
}: {
  consolidating: boolean;
  onRunNow: () => void;
}) {
  const logQ = useQuery<ConsolidationLogResponse>({
    queryKey: ['consolidation-log'],
    queryFn: () => api.get<ConsolidationLogResponse>('/api/brain/consolidation/log?limit=50'),
  });

  const lastPass = useMemo(() => {
    for (const e of logQ.data?.entries ?? []) {
      if (e.eventType === 'consolidation') return e;
    }
    return null;
  }, [logQ.data]);

  const expired = Number(lastPass?.detail?.expired ?? 0);
  const merged = Number(lastPass?.detail?.merged ?? 0);

  return (
    <div
      className="flex items-center gap-2 border-t border-white/[0.06] pt-2.5 text-[10.5px] text-muted-foreground/70"
      data-testid="memory-health-footer"
    >
      {lastPass ? (
        <span className="tabular-nums">
          expired · {expired} · duplicates merged · {merged}
        </span>
      ) : (
        <span>no consolidation pass yet</span>
      )}
      <span className="ml-auto">
        {lastPass ? `last consolidation ${timeAgo(lastPass.createdAt)}` : ''}
      </span>
      <button
        type="button"
        onClick={onRunNow}
        disabled={consolidating}
        className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:border-primary/30 hover:text-foreground disabled:opacity-40"
        title="Run one consolidation pass now (expire, merge duplicates, supersede contradictions)"
        data-testid="memory-consolidate-now"
      >
        {consolidating ? 'Running…' : 'Run now'}
      </button>
    </div>
  );
}

/* ── §5.5 raw state lookup ─────────────────────────────────────────── */

interface StateLookupResponse {
  key: string;
  found: boolean;
  source: 'internal_state' | 'memory_store' | null;
  value: unknown;
  updatedAt: string | null;
}

function RawStateLookup() {
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState('');

  const lookupQ = useQuery<StateLookupResponse>({
    queryKey: ['state-lookup', submitted],
    queryFn: () =>
      api.get<StateLookupResponse>(
        `/api/brain/state-lookup?key=${encodeURIComponent(submitted)}`,
      ),
    enabled: !!submitted,
    retry: false,
  });

  const submit = () => {
    const key = input.trim();
    setSubmitted(key);
  };

  return (
    <div className="space-y-2 border-t border-white/[0.06] pt-4" data-testid="raw-state-lookup">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
        Raw state lookup
      </div>
      <p className="text-[11px] text-muted-foreground/70">
        Type a key to inspect the raw <code className="font-mono">internal_state</code> /{' '}
        <code className="font-mono">memory_store</code> row. Machine state (
        <code className="font-mono">cognitive:*</code> and friends) is only ever visible here —
        never in Memory itself.
      </p>
      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="e.g. cognitive:boot_maintenance_state"
          className="flex-1 max-w-sm rounded-lg border border-border/60 bg-card/60 px-3 py-1.5 font-mono text-[11px] text-foreground outline-none transition focus:border-primary/40"
          data-testid="raw-state-key-input"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!input.trim() || lookupQ.isFetching}
          className="rounded-lg border border-border/60 bg-card/60 px-2.5 py-1.5 text-[11px] text-muted-foreground transition hover:border-primary/30 hover:text-foreground disabled:opacity-40"
          data-testid="raw-state-lookup-button"
        >
          {lookupQ.isFetching ? 'Looking up…' : 'Look up'}
        </button>
      </div>
      {submitted && lookupQ.data && (
        <pre
          className="max-h-64 overflow-auto rounded-lg border border-white/[0.06] bg-black/20 p-3 font-mono text-[10.5px] leading-relaxed text-foreground/80"
          data-testid="raw-state-result"
        >
          {lookupQ.data.found
            ? `-- ${lookupQ.data.source} · updated ${lookupQ.data.updatedAt ?? '?'}\n` +
              JSON.stringify(lookupQ.data.value, null, 2)
            : `no row for key ${JSON.stringify(lookupQ.data.key)}`}
        </pre>
      )}
      {submitted && lookupQ.isError && (
        <p className="text-[11px] text-destructive" data-testid="raw-state-error">
          Lookup failed: {(lookupQ.error as Error | null)?.message ?? 'unknown error'}
        </p>
      )}
    </div>
  );
}

/* ── Entry card (raw-but-readable tabs) ────────────────────────────── */

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
