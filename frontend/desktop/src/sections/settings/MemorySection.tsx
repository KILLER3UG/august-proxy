/* ── Memory — human-readable browse of what August stores ────────────── */
/* Memories + Facts tabs render one flat chronological list across kinds
 * : kind chip · title · relative date · ⋯, filter chips above
 * (not tabs), no cards/meters, and a one-line health footer fed by the
 * consolidation log.
 *
 * Detail view (Markdown body, delete, inline edit over whitelisted fields),
 * the Claude-style add-box, the two model-memory toggles, and per-entry /
 * per-store Markdown export are shared by both modes.
 *
 * Scope selector (Global + one entry per known workspace,
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
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowUp, ChevronLeft, ChevronRight, Download, MoreHorizontal, Pencil, RefreshCw, Search, Trash2, UserRoundCog } from 'lucide-react';
import { api } from '@/api/client';
import { PageLoader } from '@/components/PageLoader';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { absoluteDate, cn, timeAgo } from '@/lib/utils';
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
  config?: { modelMemoryRead?: boolean; memoryAutoInject?: boolean; modelMemoryWrites?: boolean; memorySensitiveTopics?: boolean } & Record<string, unknown>;
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

/** One memory file in a project's `.aug/memory` folder — the server's own shape
 *  (project_memory.list_files). It is a roster with a count, NOT a filename:
 *  this file used to type it `string[]` and render `{f}` directly, which threw
 *  "Objects are not valid as a React child" the moment a project had memory. */
interface ProjectFile {
  file: string;
  entries: number;
  /** ISO timestamp with its offset, from the file's mtime. */
  updated?: string;
}

/** Which pane fills the settings column. One union, because opening anything
 *  replaces the whole content — a detail region nested inside the list is what
 *  made the page read as boxes inside boxes. */
type Pane =
  | { kind: 'list' }
  | { kind: 'global' }
  | { kind: 'project'; workspace: WorkspaceInfo }
  | { kind: 'file'; workspace: WorkspaceInfo; file: string };

/** C-9: /api/august/memory/manage {action:list, scope:project} response. */
interface ProjectList {
  ok?: boolean;
  scope?: string;
  files?: ProjectFile[];
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
/* One Memory page. The rail has always shown a single "Memory" entry, and
 * `memory-knowledge` / `memory-facts` are deep-link aliases for it: asking
 * someone to choose between "Memories" and "Facts & Rules" is asking them to
 * distinguish two backend tables they never see. The stores are still what a
 * row IS (the kind chip says so) — they are just no longer the navigation. */
const PAGE_TITLE = 'Memory';
const PAGE_BLURB = 'Everything August has learned about you and your projects.';

/** The Global memory group lists every browsable store at once. */
const GLOBAL_STORES = ['facts', 'memory', 'heuristics'];

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

/* The /api/brain/stores/{name} endpoint serializes rows through the backend
 * `_row_as_wire` helper, which snake→camel-cases every column. The read
 * mappers below therefore key off the camelCase wire names (factKey,
 * factValue, updatedAt, expiresAt, createdAt, eventSummary). The `editable`
 * arrays and the PATCH body stay snake_case — that is the write path, which
 * the backend whitelists by column name. `toCamel` bridges the two: it maps a
 * snake editable/field key to the camelCase key present on the wire row so the
 * inline-edit draft can pre-populate from the row. */
function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** facts.factValue is stored as JSON; the remember tool writes
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

/** Part 27 C3: a KV note's summary is its first line, clamped — never the
 *  whole raw value (a legacy blob used to render 29 KB of JSON as one line).
 *  The full value (pretty-printed when it parses as JSON) rides in details. */
function summarizeKvValue(raw: unknown): { summary: string; details: string } {
  const s = str(raw);
  const firstLine = (s.split('\n')[0] || '').trim();
  const summary =
    firstLine.length > 160 ? `${firstLine.slice(0, 160).trimEnd()}…` : firstLine || '(empty)';
  let details = s;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object') details = JSON.stringify(parsed, null, 2);
  } catch {
    /* not JSON — keep raw */
  }
  return { summary, details };
}

const STORE_META: Record<string, StoreMeta> = {
  facts: {
    idField: 'id',
    title: (r) => str(r.factKey),
    summary: (r) => parseFactValue(r.factValue).summary,
    details: (r) => parseFactValue(r.factValue).details,
    category: (r) => str(r.category),
    source: (r) => str(r.source),
    updated: (r) => str(r.updatedAt),
    editable: ['fact_value', 'category', 'confidence', 'expires_at'],
    deletable: true,
  },
  memory: {
    idField: 'key',
    title: (r) => str(r.key),
    summary: (r) => summarizeKvValue(r.value).summary,
    details: (r) => summarizeKvValue(r.value).details,
    updated: (r) => str(r.updatedAt),
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
    updated: (r) => str(r.updatedAt),
    legacy: true,
    readOnly: true,
    deletable: true,
  },
};

/* ── §5.1 flat-list kinds ──────────────────────────────────────────── */

type EntryKind = 'profile' | 'fact' | 'lesson' | 'pref' | 'note';

const KIND_META: Record<EntryKind, { label: string; className: string }> = {
  profile: { label: 'profile', className: 'border-violet-500/30 bg-violet-500/10 text-violet-400' },
  fact: { label: 'fact', className: 'border-sky-500/30 bg-sky-500/10 text-sky-400' },
  lesson: { label: 'lesson', className: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  pref: { label: 'pref', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  note: { label: 'note', className: 'border-border/60 bg-muted/30 text-muted-foreground' },
};

const KIND_ORDER: EntryKind[] = ['profile', 'fact', 'lesson', 'pref', 'note'];

/** Kind chip for a row: a fact whose own `kind` column reads `profile` is a
 *  profile-lane entry whatever its category — that column, not the category,
 *  is what makes the backend inject it every turn. Otherwise heuristics are
 *  lessons, user-category facts are prefs, everything in the KV/legacy note
 *  stores is a note. */
function deriveKind(store: string, r: Row): EntryKind {
  if (str(r.kind).trim().toLowerCase() === 'profile') return 'profile';
  if (store === 'heuristics') return 'lesson';
  if (store === 'facts') return str(r.category).toLowerCase() === 'user' ? 'pref' : 'fact';
  return 'note';
}

/** The store whose browsable rows can carry a `kind`, i.e. join / leave the
 *  profile lane. Mirrors the PATCH whitelist in memory_store/brain.py
 *  (`'facts': frozenset({…, 'kind', …})`) — no other browsable table has the
 *  column, so the promote/demote action must not render for them. */
const KIND_EDITABLE_STORE = 'facts';

/* SQLite's datetime('now') is UTC and serialises as "YYYY-MM-DD HH:MM:SS" with
 * no zone marker, which JS then reads as LOCAL time: on a UTC+8 machine a fact
 * learned two minutes ago rendered as "8h ago", and an expiry was judged eight
 * hours early. Tag the zone before parsing anything from the store wire. Only
 * that exact shape is touched — a date-only ISO or a real offset passes
 * through. */
function asUtc(stamp: string): string {
  const s = (stamp || '').trim();
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
}

function hasExpiry(r: Row): boolean {
  return str(r.expiresAt).trim() !== '';
}

/** C-8: a fact whose expiresAt is in the past — visually separated from
 *  live expiring rows (which still have time left). */
function isExpired(r: Row): boolean {
  const t = Date.parse(asUtc(str(r.expiresAt)));
  return Number.isFinite(t) && t < Date.now();
}

function sortTime(r: Row, meta: StoreMeta | undefined): number {
  const t = Date.parse(asUtc(meta?.updated?.(r) ?? ''));
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

/* What a row says out loud in the merged list: the memory itself, not the slug
 * the store keys it by. Facts and KV notes both stored their text behind a
 * machine key, so a row used to read `user:plant` where the memory is "My plant
 * is named Gerald". The key stays the detail header and the remember/forget
 * handle. */
function rowTitle(store: string, row: Row): string {
  if (store === 'facts') return parseFactValue(row.factValue).summary || str(row.factKey);
  if (store === 'memory') return summarizeKvValue(row.value).summary || str(row.key);
  return STORE_META[store]?.title(row) || '(untitled)';
}

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

/* The pane reads as four groups in the order the questions arrive: what memory
 * is allowed to do, what it knows about you everywhere, what it knows inside one
 * project, and the August-specific surface under that. Groups are separated by a
 * rule, not by a box — a box around every group is what made the page read as
 * stacked cards instead of one list you scan. */
function MemoryGroup({
  title,
  aside,
  children,
  testId,
}: {
  title: string;
  aside?: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section
      className="border-t border-white/[0.07] pt-3 first:border-t-0 first:pt-0"
      data-testid={testId}
    >
      <div className="flex items-baseline gap-3 pb-0.5">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground/55">
          {title}
        </h2>
        {aside && (
          <span
            className="ml-auto shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70"
            data-testid={`${testId}-aside`}
          >
            {aside}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}



export function MemorySection({ active }: { active: { id: string } }) {
  const qc = useQueryClient();
  const { state: confirmState, confirm, handleConfirm, handleCancel } = useConfirmDialog();

  // Which store the open row came from — DetailView's metadata, not a nav state.
  const [activeStore, setActiveStore] = useState<string>(GLOBAL_STORES[0]);
  const [mode, setMode] = useState<'list' | 'detail'>('list');
  const [selected, setSelected] = useState<Row | null>(null);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [addText, setAddText] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [kindFilter, setKindFilter] = useState<'all' | EntryKind | 'expiring'>('all');
  const [unifiedShown, setUnifiedShown] = useState(UNIFIED_RENDER);
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

  // A deep link to either alias lands on the same page; clear the browse state
  // so arriving from a stale link never shows another entry's filters.
  useEffect(() => {
    setActiveStore(GLOBAL_STORES[0]);
    setMode('list');
    setSelected(null);
    setEditing(false);
    setSearch('');
    setKindFilter('all');
    setUnifiedShown(UNIFIED_RENDER);
    setCatFilter('');
    setSrcFilter('');
    setConfFilter('');
    setSort('newest');
    setChecked(new Set());
    setUnifiedOffset(0);
  }, [active.id]);

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
  // The Global memory group merges every browsable store into one
  // chronological list — the kind chip, not a second page, is what tells a
  // fact from a KV note from a legacy lesson.
  // C-5: real pagination — UNIFIED_FETCH rows per page per store with a movable
  // offset, so page 2+ reaches rows past the old hard 200 cap.
  const unifiedFetch = (store: string) =>
    api.get<StorePage>(
      `/api/brain/stores/${encodeURIComponent(store)}` +
        `?limit=${UNIFIED_FETCH}&offset=${unifiedOffset}&query=${encodeURIComponent(query)}` +
        `&sort=${encodeURIComponent(sort)}` +
        (catFilter ? `&category=${encodeURIComponent(catFilter)}` : '') +
        (srcFilter ? `&source=${encodeURIComponent(srcFilter)}` : '') +
        (confFilter ? `&confidence=${encodeURIComponent(confFilter)}` : ''),
    );
  const unifiedQueryKey = (store: string) =>
    ['brain-store', store, unifiedOffset, query, UNIFIED_FETCH, catFilter, srcFilter, confFilter, sort];
  const [storeA, storeB, storeC] = GLOBAL_STORES;
  const unifiedQa = useQuery<StorePage>({
    queryKey: unifiedQueryKey(storeA),
    queryFn: () => unifiedFetch(storeA),
  });
  const unifiedQb = useQuery<StorePage>({
    queryKey: unifiedQueryKey(storeB),
    queryFn: () => unifiedFetch(storeB),
  });
  const unifiedQc = useQuery<StorePage>({
    queryKey: unifiedQueryKey(storeC),
    queryFn: () => unifiedFetch(storeC),
  });
  const storeQueries = [unifiedQa, unifiedQb, unifiedQc];

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['brain-stores'] });
    void qc.invalidateQueries({ queryKey: ['brain-store'] });
  };

  const configMut = useMutation({
    mutationFn: (patch: Record<string, boolean>) => api.put('/api/brain/config', patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['brain-config'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Could not update setting'),
  });
  const addMut = useMutation({
    // The manage route lives on the august router (/api/august prefix) —
    // posting to /api/memory/manage 404s.
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
  /** Promote / demote a fact through the profile lane. Deliberately NOT an
   *  optimistic write: this column is the model's always-in-context input, so
   *  a local guess the server never accepted is worse than a spinner. The
   *  row's kind comes back from the refetch (`invalidate`), not from here. */
  const laneMut = useMutation({
    mutationFn: (p: { store: string; id: string; kind: EntryKind }) =>
      api.patch<{ row?: Row }>(
        `/api/brain/stores/${encodeURIComponent(p.store)}/${encodeURIComponent(p.id)}`,
        { kind: p.kind },
      ),
    onSuccess: (_res, p) => {
      invalidate();
      toast.success(p.kind === 'profile' ? 'Added to the profile lane' : 'Removed from the profile lane');
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

  /* Merge every browsable store into one flat chronological list. */
  const flatEntries = useMemo<FlatEntry[]>(() => {
    const pages: Array<[string, StorePage | undefined]> = [
      [storeA, unifiedQa.data],
      [storeB, unifiedQb.data],
      [storeC, unifiedQc.data],
    ];
    const out: FlatEntry[] = [];
    for (const [store, page] of pages) {
      if (!store) continue;
      const m = STORE_META[store];
      for (const row of page?.rows ?? []) {
        out.push({
          store,
          row,
          id: str(row[m?.idField ?? 'id']),
          kind: deriveKind(store, row),
          title: rowTitle(store, row),
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
  }, [storeA, storeB, storeC, unifiedQa.data, unifiedQb.data, unifiedQc.data]);

  const kindCounts = useMemo(() => {
    const counts: Record<'all' | EntryKind | 'expiring', number> = {
      all: flatEntries.length,
      profile: 0,
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
  const unifiedTotal =
    (unifiedQa.data?.total ?? 0) + (unifiedQb.data?.total ?? 0) + (unifiedQc.data?.total ?? 0);
  const unifiedCanPrev = unifiedOffset > 0;
  const unifiedCanNext = unifiedOffset + UNIFIED_FETCH < unifiedTotal;

  // The group header answers "how much does August remember about me, and when
  // did it last learn something" without anyone counting rows.
  const newestGlobal = flatEntries.reduce(
    (acc, e) => Math.max(acc, sortTime(e.row, STORE_META[e.store])),
    0,
  );

  const openDetail = (r: Row, store?: string) => {
    if (store) setActiveStore(store);
    setSelected(r);
    setEditing(false);
    setMode('detail');
  };

  const startEdit = () => {
    if (!selected || !meta?.editable) return;
    const draft: Record<string, string> = {};
    // editable keys are snake_case (the PATCH/write path); the row is the
    // camelCase wire shape, so read the converted key while seeding the draft.
    for (const f of meta.editable) draft[f] = str(selected[toCamel(f)]);
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
    downloadMarkdown('global-memory-export.md', body);
  };

  /* The bottom bar writes a fact — the store recall reads and the model can be
   * told to forget by key. Category and expiry are per-entry edits (both are in
   * the facts edit whitelist), so they live in the row's edit view rather than
   * in front of every write. Project notes go through the md-file door in that
   * project's own pane. */
  const addGlobalMemory = () => {
    const text = addText.trim();
    if (!text) return;
    addMut.mutate({
      action: 'set',
      key: `user:${slugify(text)}`,
      value: text,
      source: 'user',
    });
  };

  const cfg = configQ.data?.config;
  const unifiedLoading = storeQueries.some((q) => q.isLoading);
  const unifiedError = storeQueries.reduce<unknown>(
    (acc, q) => acc ?? (q.isError ? q.error : null),
    null,
  );
  const workspaces = workspacesQ.data?.workspaces ?? [];
  // The Project group's empty state distinguishes "nothing has memory yet" from
  // "pick one" — the first is a fact about August, the second is a prompt.
  const projectsWithMemory = workspaces.filter((w) => w.hasMemory);
  // Which pane fills the column. Opening a memory, a project, or one of that
  // project's files replaces the WHOLE settings content.
  const [pane, setPane] = useState<Pane>({ kind: 'list' });
  const detailOpen = mode === 'detail' && !!selected && !!meta;

  return (
    <div className="px-8 py-6 max-w-3xl">
      {pane.kind === 'file' ? (
        <ProjectFilePane
          workspace={pane.workspace}
          file={pane.file}
          onBack={() => setPane({ kind: 'project', workspace: pane.workspace })}
        />
      ) : pane.kind === 'project' ? (
        <ProjectMemoryPane
          workspace={pane.workspace}
          onBack={() => setPane({ kind: 'list' })}
          onOpenFile={(file) => setPane({ kind: 'file', workspace: pane.workspace, file })}
        />
      ) : detailOpen ? (
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
      ) : (
        <>
      <div className="pb-1">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">{PAGE_TITLE}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">{PAGE_BLURB}</p>
      </div>

      {/* Global memory opens as its own pane, exactly like a project does: the
          column shows only the browse, with a back that returns here. */}
      {pane.kind === 'global' && (
        <PaneHeader
          testId="memory-global-pane-header"
          backLabel="Memory"
          onBack={() => setPane({ kind: 'list' })}
          title="Global memory"
          subtitle={`${unifiedTotal} ${unifiedTotal === 1 ? 'memory' : 'memories'} August applies to every project.`}
        />
      )}

      <div className="space-y-5 pt-4">
      {pane.kind !== 'global' && (
      <MemoryGroup testId="memory-group-behavior" title="Memory behavior">
        {/* Model-memory toggles: one line each, separated by rules. */}
        <div className="divide-y divide-white/[0.06]">
        <SettingsToggle
          checked={Boolean(cfg?.modelMemoryRead ?? true)}
          onCheckedChange={(next) => configMut.mutate({ modelMemoryRead: next })}
          label="Model can read memories on demand"
          description="Offers the memory lookup tools (brain_query / list_facts) and loads the memory index — one line per fact with its recall hook — at the start of every session."
          disabled={configQ.isLoading || configMut.isPending}
          data-testid="memory-model-read-toggle"
        />
        <SettingsToggle
          checked={Boolean(cfg?.memoryAutoInject ?? false)}
          onCheckedChange={(next) => configMut.mutate({ memoryAutoInject: next })}
          label="Auto-inject relevant memories each turn"
          description="Off (recommended): the model sees the memory index at session start and pulls full facts when it calls them. On: a block of facts relevant to the latest turn is additionally added to every message."
          disabled={configQ.isLoading || configMut.isPending}
          data-testid="memory-auto-inject-toggle"
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
      </MemoryGroup>
      )}

      <MemoryGroup
        testId="memory-group-global"
        title="Global memory"
        aside={`${unifiedTotal} ${unifiedTotal === 1 ? 'memory' : 'memories'}${
          newestGlobal ? ` · updated ${timeAgo(new Date(newestGlobal))}` : ''
        }`}
      >
        {pane.kind !== 'global' ? (
          <MemoryRow
            testId="memory-global-row"
            title="All global memories"
            detail="What August knows about you in every project"
            meta={`${unifiedTotal} ${unifiedTotal === 1 ? 'memory' : 'memories'}`}
            onClick={() => setPane({ kind: 'global' })}
          />
        ) : storesQ.isLoading ? (
          <PageLoader label="Loading memory stores…" variant="card" className="py-6" />
        ) : (
          <>
          {/* Search + filters + sort + refresh + export-store */}
          <div className="flex flex-wrap items-center gap-2 pb-1">
            <div className="relative flex-1 max-w-sm min-w-44">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setUnifiedOffset(0);
                  setUnifiedShown(UNIFIED_RENDER);
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
          </div>

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

              {/* The profile lane would otherwise be an unexplained chip: these
                  facts ride along on every turn instead of being recalled by
                  keyword, so a row in it costs context continuously. */}
              {kindCounts.profile > 0 && (
                <p className="text-[10.5px] text-muted-foreground/70" data-testid="memory-profile-explainer">
                  profile · always in the model’s context on every turn, not recalled by keyword.
                  Use a row’s ⋯ menu to add or remove entries.
                </p>
              )}

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
                          for (const f of m.editable) draft[f] = str(e.row[toCamel(f)]);
                          setEditDraft(draft);
                          setEditing(true);
                        }
                      }}
                      onDelete={() => requestDelete(e.row, e.store)}
                      onExport={() => exportEntry(e.row, e.store)}
                      laneLabel={
                        e.store === KIND_EDITABLE_STORE
                          ? e.kind === 'profile'
                            ? 'Remove from profile'
                            : 'Add to profile'
                          : null
                      }
                      laneBusy={
                        laneMut.isPending &&
                        laneMut.variables?.store === e.store &&
                        laneMut.variables?.id === e.id
                      }
                      onToggleLane={() =>
                        laneMut.mutate({
                          store: e.store,
                          id: e.id,
                          kind: e.kind === 'profile' ? 'fact' : 'profile',
                        })
                      }
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
          )}
      </MemoryGroup>

      {/* One line per project that has a memory folder; the row opens that
          project's pane. */}
      <MemoryGroup
        testId="memory-group-project"
        title="Project memory"
        aside={
          projectsWithMemory.length > 0
            ? `${projectsWithMemory.length} project${projectsWithMemory.length === 1 ? '' : 's'}`
            : undefined
        }
      >
        {projectsWithMemory.length === 0 ? (
          <p
            className="py-3 text-[11.5px] text-muted-foreground"
            data-testid="memory-project-group-empty"
          >
            No project memories yet. Open a project and chat with August — its memory folder
            appears here.
          </p>
        ) : (
          <div className="divide-y divide-white/[0.06]" data-testid="memory-project-rows">
            {projectsWithMemory.map((w) => (
              <MemoryRow
                key={w.path}
                testId="memory-project-row"
                title={w.name}
                detail={w.path}
                meta={`${w.sessions} session${w.sessions === 1 ? '' : 's'}`}
                onClick={() => setPane({ kind: 'project', workspace: w })}
              />
            ))}
          </div>
        )}
      </MemoryGroup>

      {/* Import from another AI — prominent row (Claude-parity layout):
          title + description on the left, a single "Start import" action on
          the right. Opens the parser dialog (Markdown / JSON export). */}
      <div className="flex items-start justify-between gap-4 rounded-xl border border-white/[0.06] bg-card/60 p-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            Import memory from other AI providers
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Bring relevant context and data from another AI provider into August. Drop a
            Markdown or JSON memory export — August parses it into entries you can review
            before importing.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="shrink-0 rounded-lg border border-border/60 bg-card px-3.5 py-2 text-xs font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/60"
          data-testid="memory-import-open"
        >
          Start import
        </button>
      </div>
      </div>

      <BottomAddBar
        testId="memory-add"
        placeholder="Add a memory, e.g. “My plant is named Gerald”"
        value={addText}
        onChange={setAddText}
        onSubmit={addGlobalMemory}
        pending={addMut.isPending}
      />
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
          // Invalidate every memory observer (store counts + the active
          // unified list + project view), same as add/delete/edit — a plain
          // refetch of the two query objects missed the counts and any store
          // the import actually wrote to, so the list looked stale.
          invalidate();
          void qc.invalidateQueries({ queryKey: ['memory-workspaces'] });
          void qc.invalidateQueries({ queryKey: ['project-memory'] });
        }}
      />
    </div>
  );
}

/* ── §5.1 kind chip ────────────────────────────────────────────────── */

/* A pane header with its own back control. Because opening a memory, a project
 * or a file replaces the whole content column, the back affordance belongs to
 * the pane rather than to a region inside the list. */
function PaneHeader({
  title,
  subtitle,
  onBack,
  backLabel,
  actions,
  testId,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  backLabel: string;
  actions?: ReactNode;
  testId: string;
}) {
  return (
    <div className="flex items-start gap-3 pb-1" data-testid={testId}>
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 mt-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11.5px] text-muted-foreground transition hover:text-foreground"
        data-testid={`${testId}-back`}
      >
        <ChevronLeft className="size-3.5" /> {backLabel}
      </button>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[17px] font-semibold tracking-tight text-foreground">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground" title={subtitle}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/* One scannable line: label left, the fact about it right, a hair below. The
 * whole line is the hit target when it opens a pane. */
function MemoryRow({
  title,
  detail,
  meta,
  actions,
  onClick,
  testId,
}: {
  title: string;
  detail?: string;
  meta?: string;
  actions?: ReactNode;
  onClick?: () => void;
  testId?: string;
}) {
  const className =
    'flex w-full items-center gap-3 py-2.5 text-left' +
    (onClick ? ' cursor-pointer transition hover:bg-white/[0.03]' : '');
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-foreground/90">{title}</span>
        {detail && (
          <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground/75" title={detail}>
            {detail}
          </span>
        )}
      </span>
      {meta && (
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/60">{meta}</span>
      )}
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={className} data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className={className} data-testid={testId}>
      {body}
    </div>
  );
}

/* One project's memory folder as its own pane: the .md files first (each one
 * opens and reads), then the entries they parse into. */
function ProjectMemoryPane({
  workspace,
  onBack,
  onOpenFile,
}: {
  workspace: WorkspaceInfo;
  onBack: () => void;
  onOpenFile: (file: string) => void;
}) {
  const qc = useQueryClient();
  const { state: confirmState, confirm, handleConfirm, handleCancel } = useConfirmDialog();
  const [filter, setFilter] = useState('');
  const [text, setText] = useState('');

  const listQ = useQuery<ProjectList>({
    queryKey: ['project-memory', workspace.path],
    queryFn: () =>
      api.post<ProjectList>('/api/august/memory/manage', {
        action: 'list',
        scope: 'project',
        workspace: workspace.path,
      }),
  });
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ['project-memory', workspace.path] });

  const addMut = useMutation({
    mutationFn: (value: string) =>
      api.post('/api/august/memory/manage', {
        action: 'set',
        scope: 'project',
        workspace: workspace.path,
        key: value.split('\n')[0].slice(0, 80),
        value,
        details: '',
      }),
    onSuccess: () => {
      setText('');
      invalidate();
      toast.success('Memory saved');
    },
    onError: (e: Error) => toast.error(e.message || 'Could not save memory'),
  });

  const removeEntry = (title: string) => {
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
          workspace: workspace.path,
          key: title,
        })
        .then(() => {
          invalidate();
          toast.success('Project entry deleted');
        })
        .catch((e: Error) => toast.error(e.message || 'Delete failed'));
    });
  };

  const all = listQ.data?.entries ?? [];
  const q = filter.trim().toLowerCase();
  const entries = q
    ? all.filter((e) => e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q))
    : all;
  const files = listQ.data?.files ?? [];

  return (
    <div className="space-y-4" data-testid="memory-project-pane">
      <PaneHeader
        testId="memory-project-pane-header"
        backLabel="Memory"
        onBack={onBack}
        title={workspace.name}
        subtitle={workspace.path}
      />

      {listQ.isLoading ? (
        <PageLoader label="Loading project memory…" variant="card" className="py-6" />
      ) : listQ.isError ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {(listQ.error as Error | null)?.message ?? 'Could not read this project’s memory.'}
        </p>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-0 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search this project’s memory…"
              className="w-full border-b border-white/[0.08] bg-transparent py-1.5 pl-6 pr-2 text-[12.5px] text-foreground outline-none transition focus:border-primary/40"
              data-testid="memory-project-search"
            />
          </div>

          <section className="border-t border-white/[0.07] pt-2" data-testid="memory-project-files">
            <h3 className="pb-0.5 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground/55">
              Files
            </h3>
            <div className="divide-y divide-white/[0.06]">
              {files.length === 0 ? (
                <p className="py-3 text-[11.5px] text-muted-foreground">
                  No memory files yet in this project.
                </p>
              ) : (
                files.map((f) => (
                  <MemoryRow
                    key={f.file}
                    testId="memory-project-file"
                    title={f.file}
                    detail={`${f.entries} ${f.entries === 1 ? 'entry' : 'entries'}`}
                    meta={f.updated ? absoluteDate(f.updated) : ''}
                    onClick={() => onOpenFile(f.file)}
                  />
                ))
              )}
            </div>
          </section>

          <section className="border-t border-white/[0.07] pt-2" data-testid="memory-project-entries">
            <h3 className="pb-0.5 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground/55">
              Entries
            </h3>
            <div className="divide-y divide-white/[0.06]">
              {entries.length === 0 ? (
                <p className="py-3 text-[11.5px] text-muted-foreground">
                  {q ? `Nothing here matches “${filter.trim()}”.` : 'No entries yet.'}
                </p>
              ) : (
                entries.map((e) => (
                  <MemoryRow
                    key={e.key}
                    testId="memory-project-entry"
                    title={e.title}
                    detail={e.body.split('\n')[0]}
                    meta={e.updated ? timeAgo(e.updated) : ''}
                    actions={
                      <button
                        type="button"
                        onClick={() => removeEntry(e.title)}
                        aria-label={`Delete ${e.title}`}
                        className="rounded p-1 text-muted-foreground/50 transition hover:text-destructive"
                        data-testid="memory-project-delete"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    }
                  />
                ))
              )}
            </div>
          </section>
        </>
      )}

      <BottomAddBar
        testId="memory-project-add"
        placeholder="Add to this project’s memory, e.g. “NSIS is legacy here”"
        value={text}
        onChange={setText}
        onSubmit={() => text.trim() && addMut.mutate(text.trim())}
        pending={addMut.isPending}
      />

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
    </div>
  );
}

/* A memory file's own text. It is read through the same door that lists it, and
 * the name is validated server-side against list_files(), so this pane cannot be
 * pointed anywhere else on disk. */
function ProjectFilePane({
  workspace,
  file,
  onBack,
}: {
  workspace: WorkspaceInfo;
  file: string;
  onBack: () => void;
}) {
  const fileQ = useQuery<{ ok: boolean; text?: string; error?: string }>({
    queryKey: ['project-memory-file', workspace.path, file],
    queryFn: () =>
      api.post('/api/august/memory/manage', {
        action: 'read',
        scope: 'project',
        workspace: workspace.path,
        key: file,
      }),
    retry: false,
  });

  return (
    <div className="space-y-4" data-testid="memory-file-pane">
      <PaneHeader
        testId="memory-file-pane-header"
        backLabel={workspace.name}
        onBack={onBack}
        title={file}
        subtitle="The file this project’s memory is parsed from."
      />
      {fileQ.isLoading ? (
        <PageLoader label="Loading file…" variant="card" className="py-6" />
      ) : fileQ.isError ? (
        <p className="text-[12px] text-destructive">
          {(fileQ.error as Error | null)?.message ?? 'Could not read this file.'}
        </p>
      ) : !fileQ.data?.ok ? (
        <p className="text-[12px] text-destructive">
          {fileQ.data?.error ?? 'Could not read this file.'}
        </p>
      ) : (
        <div
          className="markdown-content text-[13px] leading-relaxed text-foreground/90"
          data-testid="memory-file-text"
        >
          <Markdown content={fileQ.data.text ?? ''} />
        </div>
      )}
    </div>
  );
}

/* Claude adds memory from one pinned input at the bottom of the pane. Category
 * and expiry are per-entry edits, so they live in the entry's edit view instead
 * of standing in front of every write. */
function BottomAddBar({
  placeholder,
  value,
  onChange,
  onSubmit,
  pending,
  testId,
}: {
  testId: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  return (
    <div
      className="sticky bottom-0 -mx-8 mt-6 border-t border-white/[0.07] bg-background/95 px-8 py-3 backdrop-blur"
      data-testid={testId}
    >
      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/60 px-3 py-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim() && !pending) onSubmit();
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/60"
          data-testid={`${testId}-input`}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={pending || !value.trim()}
          aria-label="Save memory"
          className="rounded-lg bg-primary p-1.5 text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
          data-testid={`${testId}-submit`}
        >
          <ArrowUp className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

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
  laneLabel,
  laneBusy,
  onCheck,
  onView,
  onEdit,
  onDelete,
  onExport,
  onToggleLane,
}: {
  entry: FlatEntry;
  checked: boolean;
  /** Label for the profile-lane action, or null when this row has no `kind`
   *  column (only `facts` rows do — see KIND_EDITABLE_STORE). */
  laneLabel: string | null;
  laneBusy: boolean;
  onCheck: (v: boolean) => void;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
  onToggleLane: () => void;
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
          title={`Expired: ${str(entry.row.expiresAt)}`}
          data-testid="memory-expired-badge"
        >
          expired {str(entry.row.expiresAt).slice(0, 10)}
        </span>
      ) : entry.expiring ? (
        <span
          className="shrink-0 rounded border border-warning/30 bg-warning/10 px-1 py-0.5 text-[8.5px] font-medium uppercase text-warning"
          title={`Expires: ${str(entry.row.expiresAt)}`}
          data-testid="memory-expiring-badge"
        >
          expiring
        </span>
      ) : null}
      <span
        className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60"
        title={absoluteDate(asUtc(entry.updated)) || entry.updated}
      >
        {timeAgo(asUtc(entry.updated))}
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
            laneLabel={laneLabel}
            laneBusy={laneBusy}
            onToggleLane={() => {
              setMenuOpen(false);
              onToggleLane();
            }}
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
  laneLabel,
  laneBusy,
  onToggleLane,
  onView,
  onEdit,
  onDelete,
  onExport,
  onClose,
}: {
  canEdit: boolean;
  canDelete: boolean;
  /** Profile-lane action label, or null to hide the row (no `kind` column). */
  laneLabel: string | null;
  laneBusy: boolean;
  onToggleLane: () => void;
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
      {/* Profile lane: promote/demote through the same PATCH the Edit path
          uses. Server-confirmed only — the refetch decides the new chip. */}
      {laneLabel && (
        <button
          type="button"
          role="menuitem"
          onClick={onToggleLane}
          disabled={laneBusy}
          className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-violet-400 transition disabled:opacity-40"
          data-testid="memory-row-toggle-lane"
        >
          <UserRoundCog className="size-3" /> {laneBusy ? 'Saving…' : laneLabel}
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

/* ── §5.1 health footer ───────────────────── */

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
  // The row and its pane must not disagree about what an entry is called:
  // `meta.title` is the store's own key column, which is an identifier the
  // model quotes (`forget(key=…)`) not a name a person reads. The list already
  // labels rows with their text via rowTitle; the pane uses the same thing and
  // keeps the key underneath, where it is still quotable.
  const title = rowTitle(store, row);
  const entryKey = store === 'facts' ? str(row.factKey) : store === 'memory' ? str(row.key) : '';
  const summary = meta.summary(row);
  const details = meta.details?.(row);
  const category = meta.category?.(row);
  const source = meta.source?.(row);
  const updated = meta.updated?.(row);
  const created = str(row.createdAt);
  const confidence = str(row.confidence);
  const expiresAt = str(row.expiresAt);
  const expired = isExpired(row);

  return (
    <div className="space-y-4" data-testid="memory-detail-view">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="mb-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" /> Back to {store}
          </button>
          <h2 className="text-lg font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
            {title}
          </h2>
          {entryKey && entryKey !== title && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/55" data-testid="memory-detail-key">
              {entryKey}
            </p>
          )}
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
              <label
                htmlFor={`memory-edit-${f}`}
                className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {f}
              </label>
              {LONG_TEXT_FIELDS.has(f) ? (
                <textarea
                  id={`memory-edit-${f}`}
                  value={editDraft[f] ?? ''}
                  onChange={(e) => onDraftChange(f, e.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-border/60 bg-background/40 p-2 text-xs text-foreground outline-none focus:border-primary/40"
                  data-testid={`memory-edit-${f}`}
                />
              ) : (
                <input
                  id={`memory-edit-${f}`}
                  value={editDraft[f] ?? ''}
                  onChange={(e) => onDraftChange(f, e.target.value)}
                  className="w-full rounded-lg border border-border/60 bg-background/40 px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary/40"
                  data-testid={`memory-edit-${f}`}
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
          {/* A plain fact's title IS its text, so repeating it under itself is
              an echo, not a body. Show the prose only where it adds something,
              and as a hairline-separated passage rather than another box. */}
          {(summary !== title || details) && (
            <div className="border-t border-white/[0.06] pt-3">
              {summary !== title && <Markdown content={summary || '_No content_'} />}
              {details && <Markdown content={details} />}
            </div>
          )}
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
