/* ── Memory — human-readable browse of what August stores ────────────── */
/* Memories + Facts tabs render one flat chronological list across kinds
 * (plan §5.1): kind chip · title · relative date · ⋯, filter chips above
 * (not tabs), no cards/meters, and a one-line health footer fed by the
 * consolidation log.
 *
 * Detail view (Markdown body, delete, inline edit over whitelisted fields),
 * the Claude-style add-box, the two model-memory toggles, and per-entry /
 * per-store Markdown export are shared by both modes.
 *
 * Part 17 Phase C: scope selector (Global + one entry per known workspace,
 * C-1), source badges on rows (C-2), server-side category/source/confidence
 * filters + sort control (C-3/4), pagination past the 200-row fetch cap
 * (C-5), bulk select + bulk delete/export (C-6), add-box category + scope
 * (C-7), expired rows visually separated with absolute dates (C-8), the
 * project view (md files + entries + sessions bound to the workspace, C-9).
 * The unreachable non-unified card branch and 6 dead STORE_META entries are
 * gone (C-10), and heuristics rows are deletable to match the backend
 * (C-11 — brain.py _ROW_DELETABLE includes it; "legacy" only means no live
 * writer, not undeletable).
 *
 * Counts come from /api/brain/stores, rows from /api/brain/stores/{name}.
 * Writes go to /api/august/memory/manage (add-box) and
 * /api/brain/stores/{name}/{id} (edit/delete). */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Brain, ChevronLeft, ChevronRight, Download, FileUp, FolderTree, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import { PageLoader } from '@/components/PageLoader';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { WorkspaceSelect } from '@/components/workspace/WorkspaceSelect';
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

interface WorkspaceInfo {
  path: string;
  name: string;
  hasMemory?: boolean;
  hasSkills?: boolean;
  sessions?: number;
}

/** C-9: one `## <title>` entry from a project's memory.md. */
interface ProjectEntry {
  key: string;
  title: string;
  body: string;
  updated: string;
  file: string;
}

/** C-9: /api/august/memory/manage {action:list, scope:project} response. */
interface ProjectList {
  ok?: boolean;
  scope?: string;
  files?: string[];
  entries?: ProjectEntry[];
}

/** Store scope per Memory-hub sub-tab (section id → stores shown). Ids are
 *  immutable (settings-registry audit) — only the blurbs change.
 *  Part 15.2: the Timeline + Sessions sub-tabs were deleted — the
 *  episodic_timeline table IS written per turn (workbench.py:4827,4847 — the
 *  old "no live writer" note was stale, corrected 2026-09-04), but the
 *  sessions/messages/exams stores duplicate the sidebar, chat, and exam UIs.
 *  Part 21 OQ1 (2026-09-04): auto_memories retired — the phantom store entry
 *  is gone (migration 033 drops the table). */
const SCOPES: Record<string, { title: string; blurb: string; stores: string[] }> = {
  'memory-knowledge': {
    title: 'Memories',
    blurb: 'KV notes the agent keeps about you.',
    stores: ['memory'],
  },
  'memory-facts': {
    title: 'Facts & Rules',
    blurb: 'Structured facts August extracted and the behavioral rules it learned.',
    stores: ['facts', 'heuristics'],
  },
};

/** Tabs rendered as one flat chronological list across kinds (§5.1). */
const UNIFIED_TABS = new Set(['memory-knowledge', 'memory-facts']);

const SORTS: Array<{ value: string; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'confidence', label: 'Confidence' },
];

/** Per-store rendering + mutation metadata. `idField` is the row identifier
 *  (the KV memory store keys by `key`; everything else by `id`). `editable`
 *  mirrors the backend field whitelist in memory_store/brain.py; `deletable`
 *  mirrors _ROW_DELETABLE there — stores without it reject DELETE, so the
 *  button must not render. Part 17 C-10: only the 4 stores the two unified
 *  scopes actually use remain; the dead card-grid entries are gone. */
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
 * {"fact","details"} when details are present. Unwrap for display. */
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
  // C-11: heuristics is legacy (no live writer) but DELETABLE — brain.py's
  // _ROW_DELETABLE includes it, so the UI stops suppressing the button.
  heuristics: {
    idField: 'id',
    title: (r) => str(r.rule),
    summary: (r) => str(r.source),
    category: (r) => str(r.category),
    updated: (r) => str(r.updated_at),
    legacy: true,
    readOnly: true,
    deletable: true,
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

/** C-8: a fact whose expires_at is in the past — visually separated from
 *  live expiring rows (which still have time left). */
function isExpired(r: Row): boolean {
  const t = Date.parse(str(r.expires_at).replace(' ', 'T'));
  return Number.isFinite(t) && t < Date.now();
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
  expired: boolean;
  legacy: boolean;
  source: string;
}

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
  const [addText, setAddText] = useState('');
  const [addCategory, setAddCategory] = useState('general');
  // M-10 (Part 21): the add-box TTL actually reaches the store again —
  // ttl_days rides the manage call and lands as expires_at on the fact.
  const [addTtlDays, setAddTtlDays] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [kindFilter, setKindFilter] = useState<'all' | EntryKind | 'expiring'>('all');
  const [unifiedShown, setUnifiedShown] = useState(UNIFIED_RENDER);
  // C-1: scope selector — '' = Global, a path = that project's view.
  const [wsScope, setWsScope] = useState('');
  // C-3/4: server-side filters + sort (persist across page navigation).
  const [catFilter, setCatFilter] = useState('');
  const [srcFilter, setSrcFilter] = useState('');
  const [confFilter, setConfFilter] = useState('');
  const [sort, setSort] = useState('newest');
  // C-6: bulk selection over the merged list.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // C-5: pagination past the 200-row unified fetch cap.
  const [unifiedOffset, setUnifiedOffset] = useState(0);
  const query = search.trim();

  // Switching sub-tabs resets the browse state to that scope's first store.
  useEffect(() => {
    setActiveStore(scope?.stores[0] ?? 'facts');
    setMode('list');
    setSelected(null);
    setEditing(false);
    setSearch('');
    setKindFilter('all');
    setUnifiedShown(UNIFIED_RENDER);
    setWsScope('');
    setCatFilter('');
    setSrcFilter('');
    setConfFilter('');
    setSort('newest');
    setChecked(new Set());
    setUnifiedOffset(0);
  }, [active.id, scope]);

  const storesQ = useQuery<{ stores: StoreInfo[] }>({
    queryKey: ['brain-stores'],
    queryFn: () => api.get<{ stores: StoreInfo[] }>('/api/brain/stores'),
  });
  const configQ = useQuery<BrainConfigResponse>({
    queryKey: ['brain-config'],
    queryFn: () => api.get<BrainConfigResponse>('/api/brain/config'),
  });
  // C-1: known project workspaces for the scope selector.
  const workspacesQ = useQuery<{ workspaces: WorkspaceInfo[] }>({
    queryKey: ['memory-workspaces'],
    queryFn: () => api.get<{ workspaces: WorkspaceInfo[] }>('/api/august/memory/workspaces'),
  });
  // C-9: with a project scope selected, the section switches to the project
  // view — the workspace's md files + entries (Phase A door) + the sessions
  // bound to that workspace — instead of the global store rows.
  const projectQ = useQuery<ProjectList>({
    queryKey: ['project-memory', wsScope],
    queryFn: () =>
      api.post<ProjectList>('/api/august/memory/manage', {
        action: 'list',
        scope: 'project',
        workspace: wsScope,
      }),
    enabled: !!wsScope,
  });
  // Unified tabs fetch both scope stores and merge client-side (§5.1).
  // C-5: real pagination — the fetch uses UNIFIED_FETCH rows per page and a
  // movable offset, so page 2+ reaches rows past the old hard 200 cap.
  const unifiedStoreA = unified ? scope.stores[0] : '';
  const unifiedStoreB = unified ? (scope.stores[1] ?? '') : '';
  const unifiedFetch = (store: string) =>
    api.get<StorePage>(
      `/api/brain/stores/${encodeURIComponent(store)}` +
        `?limit=${UNIFIED_FETCH}&offset=${unifiedOffset}&query=${encodeURIComponent(query)}` +
        `&sort=${encodeURIComponent(sort)}` +
        (catFilter ? `&category=${encodeURIComponent(catFilter)}` : '') +
        (srcFilter ? `&source=${encodeURIComponent(srcFilter)}` : '') +
        (confFilter ? `&confidence=${encodeURIComponent(confFilter)}` : ''),
    );
  const unifiedQa = useQuery<StorePage>({
    queryKey: ['brain-store', unifiedStoreA, unifiedOffset, query, UNIFIED_FETCH, catFilter, srcFilter, confFilter, sort],
    queryFn: () => unifiedFetch(unifiedStoreA),
    enabled: unified && !!unifiedStoreA,
  });
  const unifiedQb = useQuery<StorePage>({
    queryKey: ['brain-store', unifiedStoreB, unifiedOffset, query, UNIFIED_FETCH, catFilter, srcFilter, confFilter, sort],
    queryFn: () => unifiedFetch(unifiedStoreB),
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
      void qc.invalidateQueries({ queryKey: ['memory-workspaces'] });
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
          expired: isExpired(row),
          legacy: !!m?.legacy,
          source: m?.source?.(row) ?? '',
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
    let out = flatEntries;
    if (kindFilter === 'expiring') out = out.filter((e) => e.expiring);
    else if (kindFilter !== 'all') out = out.filter((e) => e.kind === kindFilter);
    // C-8: expired rows separate to the bottom of the list, live rows first.
    return [...out].sort((a, b) => Number(b.expired) - Number(a.expired));
  }, [flatEntries, kindFilter]);

  // Server-reported totals drive the unified pager (C-5).
  const unifiedTotal = (unifiedQa.data?.total ?? 0) + (unifiedQb.data?.total ?? 0);
  const unifiedCanPrev = unifiedOffset > 0;
  const unifiedCanNext = unifiedOffset + UNIFIED_FETCH < unifiedTotal;

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

  /* C-6: bulk delete iterates the checked entries through the same per-row
   * delete door (each store row needs its own DELETE path). */
  const bulkDelete = async () => {
    const targets = flatEntries.filter((e) => checked.has(`${e.store}:${e.id}`));
    const ok = await confirm({
      title: `Delete ${checked.size} entr${checked.size === 1 ? 'y' : 'ies'}?`,
      message: `${checked.size} selected entr${checked.size === 1 ? 'y' : 'ies'} will be removed. This cannot be undone from here.`,
      confirmLabel: 'Delete all',
      variant: 'destructive',
    });
    if (!ok) return;
    let failed = 0;
    for (const e of targets) {
      const m = STORE_META[e.store];
      if (!m) continue;
      try {
        await api.delete(
          `/api/brain/stores/${encodeURIComponent(e.store)}/${encodeURIComponent(e.id)}`,
        );
      } catch {
        failed += 1;
      }
    }
    invalidate();
    setChecked(new Set());
    if (failed > 0) toast.error(`${failed} deletion${failed === 1 ? '' : 's'} failed`);
    else toast.success(`Deleted ${targets.length - failed} entr${targets.length - failed === 1 ? 'y' : 'ies'}`);
  };

  const bulkExport = () => {
    const targets = flatEntries.filter((e) => checked.has(`${e.store}:${e.id}`));
    if (targets.length === 0) return;
    const body = targets
      .map((e) => entryToMarkdown(e.store, e.row, STORE_META[e.store]))
      .join('\n\n---\n\n');
    downloadMarkdown(`memory-selected-${targets.length}.md`, body);
  };

  const exportEntry = (rowOverride?: Row, storeOverride?: string) => {
    const row = rowOverride ?? selected;
    const store = storeOverride ?? activeStore;
    const m = STORE_META[store];
    if (!row || !m) return;
    downloadMarkdown(`${slugify(m.title(row))}.md`, entryToMarkdown(store, row, m));
  };

  const exportStore = () => {
    // C-10: only the unified scopes are mounted — the per-store card-grid
    // export branch is gone with the dead card view.
    if (flatEntries.length === 0) return;
    const body = flatEntries
      .map((e) => entryToMarkdown(e.store, e.row, STORE_META[e.store]))
      .join('\n\n---\n\n');
    downloadMarkdown(`${scope?.title ?? 'memory'}-export.md`.toLowerCase().replace(/\s+/g, '-'), body);
  };

  /* C-7: the add box gains category + scope. Global writes land in facts
   * with the chosen category (no more always-general); project writes go
   * through the md-file door (scope=project + workspace). */
  const addMemory = () => {
    const text = addText.trim();
    if (!text) return;
    if (wsScope) {
      addMut.mutate({
        action: 'set',
        scope: 'project',
        workspace: wsScope,
        key: text.split('\n')[0].slice(0, 80),
        value: text,
        details: '',
      });
      return;
    }
    addMut.mutate({
      action: 'set',
      key: `user:${slugify(text)}`,
      value: text,
      category: addCategory,
      source: 'user',
      ...(addTtlDays > 0 ? { ttl_days: addTtlDays } : {}),
    });
  };

  const cfg = configQ.data?.config;
  const unifiedLoading = unified && (unifiedQa.isLoading || (!!unifiedStoreB && unifiedQb.isLoading));
  const unifiedError = unified && ((unifiedQa.isError && unifiedQa.error) || (unifiedQb.isError && unifiedQb.error));
  const workspaces = workspacesQ.data?.workspaces ?? [];

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
          {/* C-1: scope selector — Global + one entry per known workspace. */}
          <div className="flex items-center gap-2" data-testid="memory-scope-row">
            <FolderTree className="size-3.5 text-muted-foreground/70" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Scope</span>
            <div className="max-w-xs flex-1">
              <WorkspaceSelect
                value={wsScope}
                onChange={(e) => {
                  setWsScope(e.target.value);
                  setChecked(new Set());
                  setUnifiedOffset(0);
                }}
                options={[
                  { value: '', label: 'Global (all workspaces)' },
                  ...workspaces.map((w) => ({
                    value: w.path,
                    label: `${w.name}${w.hasMemory || w.hasSkills ? ' · project' : ''}`,
                  })),
                ]}
                data-testid="memory-scope-select"
                aria-label="Memory scope"
              />
            </div>
          </div>

          {/* Search + filters + sort + refresh + export-store */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 max-w-sm min-w-44">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setUnifiedOffset(0);
                  setUnifiedShown(UNIFIED_RENDER);
                  setUnifiedOffset(0);
                }}
                placeholder="Search memory…"
                className="w-full rounded-lg border border-border/60 bg-card/60 py-1.5 pl-8 pr-3 text-xs text-foreground outline-none transition focus:border-primary/40"
                data-testid="memory-search-input"
              />
            </div>
            {/* C-3: category + source filters (server-side). */}
            <select
              value={catFilter}
              onChange={(e) => {
                setCatFilter(e.target.value);
                setUnifiedOffset(0);
                setUnifiedOffset(0);
              }}
              className="rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-xs text-foreground outline-none"
              data-testid="memory-category-filter"
              aria-label="Filter by category"
            >
              <option value="">All categories</option>
              {['general', 'user', 'project', 'workflow', 'preference'].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              value={srcFilter}
              onChange={(e) => {
                setSrcFilter(e.target.value);
                setUnifiedOffset(0);
                setUnifiedOffset(0);
              }}
              className="rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-xs text-foreground outline-none"
              data-testid="memory-source-filter"
              aria-label="Filter by source"
            >
              <option value="">All sources</option>
              {['remember', 'user', 'extracted', 'lesson'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {/* C-3: confidence bucket filter (§9 F-6 — low < 0.5, medium < 0.8, high >= 0.8). */}
            <select
              value={confFilter}
              onChange={(e) => {
                setConfFilter(e.target.value);
                setUnifiedOffset(0);
              }}
              className="rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-xs text-foreground outline-none"
              data-testid="memory-confidence-filter"
              aria-label="Filter by confidence"
            >
              <option value="">All confidence</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
            {/* C-4: sort control. */}
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value);
                setUnifiedOffset(0);
                setUnifiedOffset(0);
              }}
              className="rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-xs text-foreground outline-none"
              data-testid="memory-sort"
              aria-label="Sort order"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                void storesQ.refetch();
                void unifiedQa.refetch();
                void unifiedQb.refetch();
                void workspacesQ.refetch();
              }}
              title="Refresh"
              className="rounded-lg border border-border/60 bg-card/60 p-1.5 text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
            >
              <RefreshCw className={cn('size-3.5', (unifiedQa.isFetching || unifiedQb.isFetching) && 'animate-spin')} />
            </button>
            <button
              type="button"
              onClick={exportStore}
              disabled={flatEntries.length === 0}
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

          {/* Add-box (Memories + Facts tabs) — C-7: category + scope aware. */}
          {showAddBox && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={addText}
                onChange={(e) => setAddText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addMemory();
                }}
                placeholder={
                  wsScope
                    ? `Add to this project’s memory (md file), e.g. “NSIS is legacy here”`
                    : 'Add a memory, e.g. “My plant is named Gerald”'
                }
                className="flex-1 min-w-56 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-xs text-foreground outline-none transition focus:border-primary/40"
                data-testid="memory-add-input"
              />
              {!wsScope && (
                <select
                  value={addCategory}
                  onChange={(e) => setAddCategory(e.target.value)}
                  className="rounded-lg border border-border/60 bg-card/60 px-2 py-2 text-xs text-foreground outline-none"
                  data-testid="memory-add-category"
                  aria-label="Category for the new memory"
                >
                  {['general', 'user', 'project', 'workflow', 'preference'].map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}
              {!wsScope && (
                <select
                  value={addTtlDays}
                  onChange={(e) => setAddTtlDays(Number(e.target.value))}
                  className="rounded-lg border border-border/60 bg-card/60 px-2 py-2 text-xs text-foreground outline-none"
                  data-testid="memory-add-ttl"
                  aria-label="Expiry for the new memory"
                >
                  <option value={0}>never expires</option>
                  {[7, 30, 90].map((d) => (
                    <option key={d} value={d}>{`expires in ${d}d`}</option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={addMemory}
                disabled={addMut.isPending || !addText.trim()}
                className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
                data-testid="memory-add-button"
              >
                <Plus className="size-3.5" /> Add{wsScope ? ' to project' : ''}
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
          ) : wsScope ? (
            /* C-9: project scope view — md files + entries + sessions bound
             * to the workspace, replacing the global store rows. */
            <ProjectMemoryView
              workspacePath={wsScope}
              query={query}
              data={projectQ.data}
              loading={projectQ.isLoading}
              error={projectQ.isError ? (projectQ.error as Error | null)?.message ?? 'unknown error' : ''}
              sessions={workspaces.find((w) => w.path === wsScope)?.sessions ?? 0}
              onDelete={(title) => {
                void confirm({
                  title: 'Delete this project entry?',
                  message: `“${title}” will be removed from this project's memory file. This cannot be undone from here.`,
                  confirmLabel: 'Delete',
                  variant: 'destructive',
                }).then((ok) => {
                  if (!ok) return;
                  api
                    .post('/api/august/memory/manage', {
                      action: 'delete',
                      scope: 'project',
                      workspace: wsScope,
                      key: title,
                    })
                    .then(() => {
                      void qc.invalidateQueries({ queryKey: ['project-memory'] });
                      toast.success('Project entry deleted');
                    })
                    .catch((e: Error) => toast.error(e.message || 'Delete failed'));
                });
              }}
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
                {/* C-6: bulk bar appears when rows are checked. */}
                {checked.size > 0 && (
                  <>
                    <span className="ml-2 text-[11px] text-muted-foreground" data-testid="memory-bulk-count">
                      {checked.size} selected
                    </span>
                    <button
                      type="button"
                      onClick={() => void bulkExport()}
                      className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-card/60 px-2 py-1 text-[11px] text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
                      data-testid="memory-bulk-export"
                    >
                      <Download className="size-3" /> Export selected
                    </button>
                    <button
                      type="button"
                      onClick={() => void bulkDelete()}
                      className="inline-flex items-center gap-1 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive transition hover:bg-destructive/20"
                      data-testid="memory-bulk-delete"
                    >
                      <Trash2 className="size-3" /> Delete selected
                    </button>
                  </>
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
                      checked={checked.has(`${e.store}:${e.id}`)}
                      onCheck={(v) =>
                        setChecked((prev) => {
                          const next = new Set(prev);
                          const k = `${e.store}:${e.id}`;
                          if (v) next.add(k);
                          else next.delete(k);
                          return next;
                        })
                      }
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

              {/* C-5: server-side pager past the 200-row cap. */}
              {unifiedTotal > UNIFIED_FETCH && (
                <div className="flex items-center justify-between text-xs text-muted-foreground" data-testid="memory-unified-pager">
                  <span className="tabular-nums" data-testid="memory-unified-range">
                    {unifiedOffset + 1}–{Math.min(unifiedOffset + UNIFIED_FETCH, unifiedTotal)} of {unifiedTotal}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={!unifiedCanPrev}
                      onClick={() => {
                        setUnifiedOffset(Math.max(0, unifiedOffset - UNIFIED_FETCH));
                        setUnifiedShown(UNIFIED_RENDER);
                        setChecked(new Set());
                      }}
                      className="rounded-md border border-border/60 p-1 transition enabled:hover:text-foreground disabled:opacity-40"
                      title="Previous 200"
                    >
                      <ChevronLeft className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={!unifiedCanNext}
                      onClick={() => {
                        setUnifiedOffset(unifiedOffset + UNIFIED_FETCH);
                        setUnifiedShown(UNIFIED_RENDER);
                        setChecked(new Set());
                      }}
                      className="rounded-md border border-border/60 p-1 transition enabled:hover:text-foreground disabled:opacity-40"
                      title="Next 200"
                    >
                      <ChevronRight className="size-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* §5.1 health footer — the §3.5 audit surface. */}
              <HealthFooter
                consolidating={consolidateMut.isPending}
                onRunNow={() => consolidateMut.mutate()}
              />
            </>
          ) : (
            <p className="rounded-xl border border-white/[0.06] bg-card/60 px-4 py-6 text-center text-xs text-muted-foreground">
              This store is not browsable from here.
            </p>
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
  checked,
  onCheck,
  onView,
  onEdit,
  onDelete,
  onExport,
}: {
  entry: FlatEntry;
  checked: boolean;
  onCheck: (v: boolean) => void;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const meta = STORE_META[entry.store];
  const canEdit = !!meta?.editable && !meta?.readOnly;
  const canDelete = !!meta?.deletable;
  const kind = KIND_META[entry.kind];

  return (
    <div
      className={cn('group relative flex items-center gap-2.5 py-2', entry.expired && 'opacity-50')}
      data-testid="memory-flat-row"
      data-kind={entry.kind}
      data-expired={entry.expired ? 'true' : undefined}
    >
      {/* C-6: bulk-select checkbox. */}
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
        className="size-3.5 shrink-0 accent-primary"
        aria-label={`Select ${entry.title}`}
        data-testid="memory-bulk-check"
      />
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
      {/* C-2: source badge — imported:<provider> and remember/user visible. */}
      {entry.source && (
        <span
          className="shrink-0 rounded border border-border/50 bg-muted/30 px-1 py-0.5 text-[8.5px] font-medium uppercase tracking-wide text-muted-foreground"
          data-testid="memory-source-badge"
        >
          {entry.source}
        </span>
      )}
      {entry.legacy && (
        <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[8.5px] font-medium uppercase text-amber-400">
          legacy
        </span>
      )}
      {entry.expired ? (
        // C-8: expired rows show the absolute date, dimmed.
        <span
          className="shrink-0 rounded border border-destructive/30 bg-destructive/10 px-1 py-0.5 text-[8.5px] font-medium uppercase text-destructive"
          title={`Expired: ${str(entry.row.expires_at)}`}
          data-testid="memory-expired-badge"
        >
          expired {str(entry.row.expires_at).slice(0, 10)}
        </span>
      ) : entry.expiring ? (
        <span
          className="shrink-0 rounded border border-warning/30 bg-warning/10 px-1 py-0.5 text-[8.5px] font-medium uppercase text-warning"
          title={`Expires: ${str(entry.row.expires_at)}`}
          data-testid="memory-expiring-badge"
        >
          expiring
        </span>
      ) : null}
      <span
        className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60"
        title={entry.updated}
      >
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

/* ── C-9: project scope view — md files + entries + bound sessions ──── */

function ProjectMemoryView({
  workspacePath,
  query,
  data,
  loading,
  error,
  sessions,
  onDelete,
}: {
  workspacePath: string;
  query: string;
  data?: ProjectList;
  loading: boolean;
  error: string;
  sessions: number;
  onDelete: (title: string) => void;
}) {
  const entries = useMemo(() => {
    const all = data?.entries ?? [];
    if (!query) return all;
    const q = query.toLowerCase();
    return all.filter(
      (e) => e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q),
    );
  }, [data, query]);
  const files = data?.files ?? [];
  const wsName = workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? workspacePath;

  if (loading) {
    return <PageLoader label="Loading project memory…" variant="card" className="py-8" />;
  }
  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-6 text-center text-xs text-destructive">
        Could not load project memory: {error}
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="memory-project-view">
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground/80">
        <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-medium uppercase tracking-wide text-emerald-400">
          project
        </span>
        <span className="font-mono" data-testid="memory-project-path">
          {workspacePath}
        </span>
        <span>· {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}</span>
        <span>· {files.length} file{files.length === 1 ? '' : 's'}</span>
        <span>· {sessions} session{sessions === 1 ? '' : 's'} bound to this workspace</span>
      </div>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="memory-project-files">
          {files.map((f) => (
            <span
              key={f}
              className="rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {f}
            </span>
          ))}
        </div>
      )}
      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/60 bg-card/40 px-4 py-6 text-center text-xs text-muted-foreground">
          No project memory yet in <strong>{wsName}</strong> — use the add-box above or the
          remember tool in a session bound to this workspace.
        </p>
      ) : (
        <div className="divide-y divide-white/[0.04]">
          {entries.map((e) => (
            <div key={e.key} className="flex items-start gap-2.5 py-2" data-testid="memory-project-entry">
              <span className="mt-0.5 w-14 shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1 py-0.5 text-center text-[9px] font-medium uppercase tracking-wide text-emerald-400">
                entry
              </span>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-foreground/90">{e.title}</span>
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                  {e.body.split('\n')[0]}
                </p>
              </div>
              {e.updated && (
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60" title={e.updated}>
                  {timeAgo(e.updated)}
                </span>
              )}
              <button
                type="button"
                onClick={() => onDelete(e.title)}
                className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition hover:text-destructive"
                aria-label={`Delete ${e.title}`}
                data-testid="memory-project-delete"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
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
  const expiresAt = str(row.expires_at);
  const expired = isExpired(row);

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
              <span
                className="rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
                data-testid="memory-detail-source"
              >
                {source}
              </span>
            )}
            {meta.legacy && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-400">
                legacy
              </span>
            )}
            {expiresAt && (
              <span
                className={cn(
                  'rounded-md border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                  expired
                    ? 'border-destructive/30 bg-destructive/10 text-destructive'
                    : 'border-warning/30 bg-warning/10 text-warning',
                )}
                data-testid="memory-detail-expiry"
              >
                {expired ? 'expired' : 'expires'} {expiresAt.slice(0, 10)}
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
          {meta.deletable && (
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
