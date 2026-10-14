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
import { BrainBackupsCard } from './BrainBackupsCard';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArchiveRestore, ArrowUp, ChevronLeft, ChevronRight, Download, Pencil, RefreshCw, Search, Trash2, UserRoundCog } from 'lucide-react';
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
  config?: { modelMemoryRead?: boolean; memoryAutoInject?: boolean; memoryReview?: boolean; modelMemoryWrites?: boolean; memorySensitiveTopics?: boolean } & Record<string, unknown>;
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
 * row IS (its section says so) — they are just no longer the navigation. */

/** The browsable stores the one list merges, in section order. */
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
  /** One-line human description, when the store has a column for it (facts
   *  does — `description`). The row shows it as the second line; when empty
   *  the row falls back to the summary. */
  description?: (r: Row) => string;
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
    // The `title` column is the name a person reads; `fact_key` is the machine
    // handle the model quotes. Both exist on the wire, and the reference design
    // (name + one-line description + updated date) reads the human pair.
    title: (r) => str(r.title).trim() || str(r.factKey),
    description: (r) => str(r.description).trim(),
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
  /** One-line description from the store's own column (facts.description),
   *  '' when the store has none. */
  description: string;
  summary: string;
  updated: string;
  expiring: boolean;
  expired: boolean;
  legacy: boolean;
  source: string;
  category: string;
  /** `facts.status === 'retired'` — consolidation parked the row and BOTH
   *  recall lanes filter it out, so it is NOT in the model's context even
   *  when its kind is `profile`. The row keeps rendering here (this is the
   *  human door) with a badge and a Restore action; without the flag the
   *  profile explainer's "always in context" claim was false for exactly
   *  these rows. */
  retired: boolean;
}

/** The row's right-hand date, the way the reference reads it: "Updated Aug 21"
 *  this year, "Updated Aug 21, 2025" when the memory is older. */
function shortUpdated(stamp: string): string {
  const t = Date.parse(asUtc(stamp));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = d.toLocaleString('en-US', { month: 'short' });
  return sameYear
    ? `Updated ${month} ${d.getDate()}`
    : `Updated ${month} ${d.getDate()}, ${d.getFullYear()}`;
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
  if (store === 'facts') {
    return str(row.title).trim() || parseFactValue(row.factValue).summary || str(row.factKey);
  }
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
/* A flat section header — the reference's shape: a small title, a quiet hint
 * at its right, then the rows separated by hairlines. No card chrome. */
function MemorySectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 pb-1">
      <h3 className="text-[0.8125rem] font-semibold tracking-tight text-foreground">{title}</h3>
      {hint && <span className="truncate text-2xs text-muted-foreground/55">{hint}</span>}
    </div>
  );
}

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
        <h2 className="text-[0.65625rem] font-semibold uppercase tracking-widest text-muted-foreground/55">
          {title}
        </h2>
        {aside && (
          <span
            className="ml-auto shrink-0 text-[0.65625rem] tabular-nums text-muted-foreground/70"
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
  const [unifiedShown, setUnifiedShown] = useState(UNIFIED_RENDER);
  // C-3/4: server-side filters + sort (persist across page navigation).
  const [catFilter, setCatFilter] = useState('');
  const [srcFilter, setSrcFilter] = useState('');
  const [confFilter, setConfFilter] = useState('');
  const [sort, setSort] = useState('newest');
  // C-6: bulk selection is opt-in — the default row carries no checkbox.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
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
  /** Un-retire a consolidation-parked fact. Deliberately the row PATCH, not
   *  the manage upsert door: an upsert re-encodes the value, clobbers source
   *  to 'user' and nulls expires_at, and a restore must change exactly one
   *  thing — status. */
  const restoreMut = useMutation({
    mutationFn: (p: { store: string; id: string }) =>
      api.patch<{ row?: Row }>(
        `/api/brain/stores/${encodeURIComponent(p.store)}/${encodeURIComponent(p.id)}`,
        { status: 'active' },
      ),
    onSuccess: () => {
      invalidate();
      toast.success('Entry restored — it is recalled again');
    },
    onError: (e: Error) => toast.error(e.message || 'Restore failed'),
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
          description: m?.description?.(row) ?? '',
          summary: m?.summary(row) ?? '',
          updated: m?.updated?.(row) ?? '',
          expiring: hasExpiry(row),
          expired: isExpired(row),
          legacy: !!m?.legacy,
          source: m?.source?.(row) ?? '',
          category: m?.category?.(row) ?? '',
          retired: str(row.status) === 'retired',
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
    // The explainer's claim is about what the model SEES. Retired profile
    // rows are parked by consolidation and both recall lanes filter on
    // status, so they count toward the chip but not toward "always in
    // context" — claiming them was the bug.
    let activeProfile = 0;
    for (const e of flatEntries) {
      counts[e.kind] += 1;
      if (e.expiring) counts.expiring += 1;
      if (e.kind === 'profile' && !e.retired) activeProfile += 1;
    }
    return { ...counts, activeProfile };
  }, [flatEntries]);

  // C-8: expired rows separate to the bottom of the list, live rows first.
  // (The kind FILTER is gone: the sections are the grouping now, so a chip
  // row would say the same thing twice.)
  const filteredEntries = useMemo(
    () => [...flatEntries].sort((a, b) => Number(b.expired) - Number(a.expired)),
    [flatEntries],
  );

  // Server-reported totals drive the unified pager (C-5).
  const unifiedTotal =
    (unifiedQa.data?.total ?? 0) + (unifiedQb.data?.total ?? 0) + (unifiedQc.data?.total ?? 0);
  const unifiedCanPrev = unifiedOffset > 0;
  const unifiedCanNext = unifiedOffset + UNIFIED_FETCH < unifiedTotal;

  // The reference's grouping: the profile lane IS the "You" section, every
  // other fact is a Topic grouped by its own category, the KV store is
  // Notes, the legacy lessons are Rules. One row renderer shared by every
  // section — the first version of this had two and they drifted.
  const sections = useMemo(() => {
    const you: FlatEntry[] = [];
    const topics: FlatEntry[] = [];
    const notes: FlatEntry[] = [];
    const rules: FlatEntry[] = [];
    for (const e of filteredEntries) {
      if (e.kind === 'profile') you.push(e);
      else if (e.store === 'heuristics') rules.push(e);
      else if (e.store === 'memory') notes.push(e);
      else topics.push(e);
    }
    const byCat = new Map<string, FlatEntry[]>();
    for (const e of topics) {
      const list = byCat.get(e.category) ?? [];
      list.push(e);
      byCat.set(e.category, list);
    }
    return { you, topics, notes, rules, topicGroups: [...byCat.entries()] };
  }, [filteredEntries]);

  /** One row renderer for every section (the old code had two and they
   *  drifted: the grouped one silently lost the lane toggle and export). */
  const rowFor = (e: FlatEntry) => (
    <FlatEntryRow
      key={`${e.store}:${e.id}`}
      entry={e}
      checked={checked.has(`${e.store}:${e.id}`)}
      selectMode={selectMode}
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
          for (const fld of m.editable) draft[fld] = str(e.row[toCamel(fld)]);
          setEditDraft(draft);
          setEditing(true);
        }
      }}
      onDelete={() => requestDelete(e.row, e.store)}
    />
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
  /* The row the detail view renders. `selected` is a SNAPSHOT taken when the
   * row was opened, and every write here deliberately does not patch it — it
   * invalidates and waits for the server (`laneMut.onSuccess` only toasts and
   * refetches). Rendering the snapshot would leave the detail's lane label
   * stale until you navigated back and re-opened the row, which is the
   * "component guessed" state the lane design exists to avoid. So the detail
   * prefers the refetched row while the store still holds it, and falls back
   * to the snapshot only while that refetch is in flight — or after a delete,
   * when the row is legitimately gone. */
  const liveSelected = useMemo(() => {
    if (!selected) return null;
    const id = str(selected[meta?.idField ?? 'id']);
    const hit = flatEntries.find((e) => e.store === activeStore && e.id === id);
    return hit?.row ?? selected;
  }, [selected, flatEntries, activeStore, meta]);
  // `detailOpen` already proves `selected` is non-null on the branch that
  // renders this, so the empty object is only there to keep the type honest
  // for the unreachable path.
  const detailRow: Row = liveSelected ?? selected ?? {};

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
          row={detailRow}
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
          laneLabel={
            activeStore === KIND_EDITABLE_STORE
              ? deriveKind(activeStore, detailRow) === 'profile'
                ? 'Remove from the always-in-context lane'
                : 'Always include in context'
              : null
          }
          laneBusy={laneMut.isPending}
          onToggleLane={() =>
            laneMut.mutate({
              store: activeStore,
              id: str(detailRow[meta.idField]),
              kind: deriveKind(activeStore, detailRow) === 'profile' ? 'fact' : 'profile',
            })
          }
          canRestore={str(detailRow.status) === 'retired'}
          restoreBusy={restoreMut.isPending}
          onRestore={() => restoreMut.mutate({ store: activeStore, id: str(selected[meta.idField]) })}
        />
      ) : (
        <>
      {/* The list IS the page — no "All global memories" click-through first.
          The reference's shape: one scannable column grouped into named
          sections (You / Topics / Notes / Rules), each row a name, a
          one-line description and an updated date, with edit and delete on
          hover. The old pane had the same rows one click deep, which made
          the page whose job is showing what August remembers open with a
          row ABOUT the list instead of the list. */}

      {/* Import from another AI — the reference's banner position: one
          prominent row at the very top, before the list it feeds. */}
      <div
        className="flex items-start justify-between gap-4 rounded-xl border border-white/[0.06] bg-card/60 p-4"
        data-testid="memory-import-banner"
      >
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

      {/* Search + server-side filters + sort + refresh + export + select. */}
      <div className="flex flex-wrap items-center gap-2 pt-4">
        <div className="relative flex-1 max-w-sm min-w-44">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/60" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setUnifiedOffset(0);
              setUnifiedShown(UNIFIED_RENDER);
            }}
            placeholder="Search memory…"
            aria-label="Search memory"
            className="w-full rounded-lg border border-border/60 bg-card/60 py-1.5 pl-8 pr-3 text-xs text-foreground outline-none transition focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/50"
            data-testid="memory-search-input"
          />
        </div>
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
          aria-label="Refresh memory stores"
          className="rounded-lg border border-border/60 bg-card/60 p-1.5 text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
          data-testid="memory-refresh"
        >
          <RefreshCw className={cn('size-3', (unifiedQa.isFetching || unifiedQb.isFetching) && 'animate-spin')} />
        </button>
        {/* C-6: bulk mode is opt-in — the default row carries no checkbox,
            because the reference's row is name/description/date and nothing
            else. The mode reveals the checkboxes and the bulk bar. */}
        <button
          type="button"
          onClick={() => {
            setSelectMode((v) => !v);
            setChecked(new Set());
          }}
          aria-pressed={selectMode}
          className={cn(
            'rounded-lg border px-2 py-1.5 text-2xs transition',
            selectMode
              ? 'border-primary/40 bg-primary/10 text-foreground'
              : 'border-border/60 bg-card/60 text-muted-foreground hover:border-primary/30 hover:text-foreground',
          )}
          data-testid="memory-select-mode"
        >
          {selectMode ? 'Done selecting' : 'Select'}
        </button>
        <button
          type="button"
          onClick={exportStore}
          disabled={flatEntries.length === 0}
          title="Export as Markdown" aria-label="Export as Markdown"
          className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-2xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground disabled:opacity-40"
        >
          <Download className="size-3" /> Export
        </button>
      </div>

      {/* C-6: bulk bar appears when rows are checked. */}
      {checked.size > 0 && (
        <div className="flex items-center gap-2" data-testid="memory-bulk-bar">
          <span className="text-2xs text-muted-foreground" data-testid="memory-bulk-count">
            {checked.size} selected
          </span>
          <button
            type="button"
            onClick={() => void bulkExport()}
            className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-card/60 px-2 py-1 text-2xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
            data-testid="memory-bulk-export"
          >
            <Download className="size-3" /> Export selected
          </button>
          <button
            type="button"
            onClick={() => void bulkDelete()}
            className="inline-flex items-center gap-1 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1 text-2xs text-destructive transition hover:bg-destructive/20"
            data-testid="memory-bulk-delete"
          >
            <Trash2 className="size-3" /> Delete selected
          </button>
        </div>
      )}

      {unifiedLoading ? (
        <PageLoader label="Loading entries…" variant="card" className="py-8" />
      ) : unifiedError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-6 text-center text-xs text-destructive">
          Could not load memory: {(unifiedError as Error | null)?.message ?? 'unknown error'}
        </div>
      ) : (
        <div className="space-y-6 pt-1">
          {/* You — the profile lane. These facts ride along on every turn
              instead of being recalled by keyword, so the section says so
              once instead of stamping a chip on every row. */}
          {sections.you.length > 0 && (
            <section data-testid="memory-section-you">
              <MemorySectionHeader
                title="You"
                hint={`always in the model's context on every turn · ${sections.you.length}`}
              />
              <div className="divide-y divide-white/[0.04]">
                {sections.you.map((e) => rowFor(e))}
              </div>
              <p className="pt-1.5 text-[0.65625rem] leading-relaxed text-muted-foreground/60" data-testid="memory-profile-explainer">
                {kindCounts.activeProfile === 1 ? 'This row is' : 'These rows are'} injected into every turn, not
                recalled by keyword. Parked rows are recalled by nothing until restored — open one to
                add or remove it from the lane.
              </p>
            </section>
          )}

          {/* Topics — every other fact, grouped by its category. */}
          {sections.topics.length > 0 && (
            <section data-testid="memory-section-topics">
              <MemorySectionHeader title="Topics" hint={`${sections.topics.length}`} />
              {sections.topicGroups.map(([category, entries]) => (
                <div key={category || 'uncategorized'} className="pt-2 first:pt-0">
                  {sections.topicGroups.length > 1 && (
                    <h4 className="pb-0.5 text-2xs font-medium uppercase tracking-widest text-muted-foreground/45">
                      {category || 'uncategorized'}
                    </h4>
                  )}
                  <div className="divide-y divide-white/[0.04]">
                    {entries.map((e) => rowFor(e))}
                  </div>
                </div>
              ))}
            </section>
          )}

          {/* Notes — the KV store. */}
          {sections.notes.length > 0 && (
            <section data-testid="memory-section-notes">
              <MemorySectionHeader title="Notes" hint={`${sections.notes.length}`} />
              <div className="divide-y divide-white/[0.04]">
                {sections.notes.map((e) => rowFor(e))}
              </div>
            </section>
          )}

          {/* Rules — legacy lessons, read-only but deletable. */}
          {sections.rules.length > 0 && (
            <section data-testid="memory-section-rules">
              <MemorySectionHeader title="Rules" hint="retired writer · kept for recall" />
              <div className="divide-y divide-white/[0.04]">
                {sections.rules.map((e) => rowFor(e))}
              </div>
            </section>
          )}

          {filteredEntries.length === 0 && (
            <p className="rounded-xl border border-white/[0.06] bg-card/60 px-4 py-6 text-center text-xs text-muted-foreground">
              {query
                ? `No entries match “${query}”.`
                : 'Nothing stored here yet.'}
            </p>
          )}
        </div>
      )}

      {/* C-5: client-side "show more" past the first render window. */}
      {filteredEntries.length > unifiedShown && (
        <button
          type="button"
          onClick={() => setUnifiedShown((n) => n + UNIFIED_RENDER)}
          className="w-full py-2 text-center text-2xs text-muted-foreground transition hover:text-foreground"
          data-testid="memory-show-more"
        >
          +{filteredEntries.length - unifiedShown} more
        </button>
      )}

      {/* C-5: server-side pager past the 200-row fetch cap. */}
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
              <ChevronLeft className="size-3" />
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
              <ChevronRight className="size-3" />
            </button>
          </div>
        </div>
      )}

      {/* §5.1 health footer — the consolidation surface. */}
      <HealthFooter
        consolidating={consolidateMut.isPending}
        onRunNow={() => consolidateMut.mutate()}
      />

      {/* The behavior gates are settings, not browse controls: they render
          in EVERY pane, including Global. They used to disappear the moment
          the global pane opened, and the layout test pinned that (2026-10-03). */}
      <MemoryGroup testId="memory-group-behavior" title="Memory behavior">
        {/* Model-memory toggles: one line each, separated by rules. */}
        <div className="divide-y divide-white/[0.06]">
        <SettingsToggle
          checked={Boolean(cfg?.modelMemoryRead ?? true)}
          onCheckedChange={(next) => configMut.mutate({ modelMemoryRead: next })}
          label="Model can read memories on demand"
          disabled={configQ.isLoading || configMut.isPending}
          data-testid="memory-model-read-toggle"
        />
        <SettingsToggle
          checked={Boolean(cfg?.memoryAutoInject ?? false)}
          onCheckedChange={(next) => configMut.mutate({ memoryAutoInject: next })}
          label="Auto-inject relevant memories each turn"
          disabled={configQ.isLoading || configMut.isPending}
          data-testid="memory-auto-inject-toggle"
        />
        <SettingsToggle
          checked={Boolean(cfg?.modelMemoryWrites)}
          onCheckedChange={(next) => configMut.mutate({ modelMemoryWrites: next })}
          label="Model can save memories"
          disabled={configQ.isLoading || configMut.isPending}
          data-testid="memory-model-writes-toggle"
        />
        <SettingsToggle
          checked={Boolean(cfg?.memoryReview)}
          onCheckedChange={(next) => configMut.mutate({ memoryReview: next })}
          label="Learn from finished conversations (off by default)"
          disabled={configQ.isLoading || configMut.isPending}
          data-testid="memory-review-toggle"
        />
        <SettingsToggle
          checked={Boolean(cfg?.memorySensitiveTopics)}
          onCheckedChange={(next) => configMut.mutate({ memorySensitiveTopics: next })}
          label="Include sensitive topics in memory (off by default)"
          disabled={configQ.isLoading || configMut.isPending}
          data-testid="memory-sensitive-toggle"
        />
      </div>
      </MemoryGroup>

      <BrainBackupsCard />


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
            className="py-3 text-[0.71875rem] text-muted-foreground"
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

      {/* The composer — the reference's bottom bar: one line, a send arrow,
          and the placeholder names what it is for (a natural-language memory
          the model will store). The old bar said "Add a memory, e.g. …",
          which read like a form field; this one reads like a sentence you
          would say. */}
      <BottomAddBar
        testId="memory-add"
        placeholder="Tell August what to remember, e.g. “My dog’s name is Beans”"
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
        className="-ml-1 mt-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[0.71875rem] text-muted-foreground transition hover:text-foreground"
        data-testid={`${testId}-back`}
      >
        <ChevronLeft className="size-3" /> {backLabel}
      </button>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[1.0625rem] font-semibold tracking-tight text-foreground">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 truncate text-[0.71875rem] text-muted-foreground" title={subtitle}>
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
        <span className="block truncate text-[0.8125rem] text-foreground/90">{title}</span>
        {detail && (
          <span className="mt-0.5 block truncate text-[0.71875rem] text-muted-foreground/75" title={detail}>
            {detail}
          </span>
        )}
      </span>
      {meta && (
        <span className="shrink-0 text-[0.65625rem] tabular-nums text-muted-foreground/60">{meta}</span>
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
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-2xs text-destructive">
          {(listQ.error as Error | null)?.message ?? 'Could not read this project’s memory.'}
        </p>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-0 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/60" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search this project’s memory…"
              className="w-full border-b border-white/[0.08] bg-transparent py-1.5 pl-6 pr-2 text-[0.78125rem] text-foreground outline-none transition focus:border-primary/40"
              data-testid="memory-project-search"
            />
          </div>

          <section className="border-t border-white/[0.07] pt-2" data-testid="memory-project-files">
            <h3 className="pb-0.5 text-[0.65625rem] font-semibold uppercase tracking-widest text-muted-foreground/55">
              Files
            </h3>
            <div className="divide-y divide-white/[0.06]">
              {files.length === 0 ? (
                <p className="py-3 text-[0.71875rem] text-muted-foreground">
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
            <h3 className="pb-0.5 text-[0.65625rem] font-semibold uppercase tracking-widest text-muted-foreground/55">
              Entries
            </h3>
            <div className="divide-y divide-white/[0.06]">
              {entries.length === 0 ? (
                <p className="py-3 text-[0.71875rem] text-muted-foreground">
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
                        <Trash2 className="size-3" />
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
        <p className="text-[0.75rem] text-destructive">
          {(fileQ.error as Error | null)?.message ?? 'Could not read this file.'}
        </p>
      ) : !fileQ.data?.ok ? (
        <p className="text-[0.75rem] text-destructive">
          {fileQ.data?.error ?? 'Could not read this file.'}
        </p>
      ) : (
        <div
          className="markdown-content text-[0.8125rem] leading-relaxed text-foreground/90"
          data-testid="memory-file-text"
        >
          <Markdown content={fileQ.data.text ?? ''} demoteHeadings />
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
          className="min-w-0 flex-1 bg-transparent text-[0.78125rem] text-foreground outline-none placeholder:text-muted-foreground/60"
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
          <ArrowUp className="size-3" />
        </button>
      </div>
    </div>
  );
}


/* One row, the way the reference reads it: the memory's NAME, a one-line
 * description under it, "Updated <date>" at the right, and — on hover — a
 * pencil and a trash. No per-row kind chip (the section header already says
 * what the row is), no checkbox unless select mode is on, no ⋯ menu: the
 * rarer actions (export, the profile lane, un-parking a retired row) live
 * in the detail view one click away. */
function FlatEntryRow({
  entry,
  checked,
  selectMode,
  onCheck,
  onView,
  onEdit,
  onDelete,
}: {
  entry: FlatEntry;
  checked: boolean;
  selectMode: boolean;
  onCheck: (v: boolean) => void;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta = STORE_META[entry.store];
  const canEdit = !!meta?.editable && !meta?.readOnly;
  const canDelete = !!meta?.deletable;
  // The second line is the store's own description column when it has one
  // (facts does), else the memory's body — and only when it says something
  // the title does not. A short fact has title == summary, and printing the
  // same words twice is how a list stops being scannable.
  const detail =
    entry.description && entry.description !== entry.title
      ? entry.description
      : entry.summary && entry.summary !== entry.title
        ? entry.summary
        : '';

  return (
    <div
      className={cn('group relative flex items-center gap-3 py-2.5', entry.expired && 'opacity-50')}
      data-testid="memory-flat-row"
      data-kind={entry.kind}
      data-expired={entry.expired ? 'true' : undefined}
    >
      {selectMode && (
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
          className="size-3 shrink-0 accent-primary"
          aria-label={`Select ${entry.title}`}
          data-testid="memory-bulk-check"
        />
      )}
      <button
        type="button"
        onClick={onView}
        className="flex min-w-0 flex-1 items-baseline gap-3 text-left"
        title={detail || entry.title}
        data-testid="memory-row-open"
      >
        <span className="min-w-0 shrink-0 basis-[38%] truncate text-[0.8125rem] font-medium text-foreground/90">
          {entry.title}
        </span>
        {detail && (
          <span className="hidden min-w-0 flex-1 truncate text-[0.71875rem] text-muted-foreground/70 sm:block">
            {detail}
          </span>
        )}
      </button>
      {/* State, not decoration: a parked or expiring row must not read as
          live. One small word each, not a chip family. */}
      {entry.retired ? (
        <span
          className="shrink-0 text-2xs text-muted-foreground/60"
          title="Parked by consolidation — no recall lane carries it. Restore it from the detail view."
          data-testid="memory-retired-badge"
        >
          parked
        </span>
      ) : entry.expired ? (
        <span
          className="shrink-0 text-2xs text-destructive/80"
          title={`Expired: ${str(entry.row.expiresAt)}`}
          data-testid="memory-expired-badge"
        >
          expired
        </span>
      ) : entry.expiring ? (
        <span
          className="shrink-0 text-2xs text-warning"
          title={`Expires: ${str(entry.row.expiresAt)}`}
          data-testid="memory-expiring-badge"
        >
          expiring
        </span>
      ) : null}
      <span
        className="shrink-0 text-2xs tabular-nums text-muted-foreground/55"
        title={absoluteDate(asUtc(entry.updated)) || entry.updated}
        data-testid="memory-row-updated"
      >
        {shortUpdated(entry.updated)}
      </span>
      {/* Hover actions; focus-within keeps them reachable without a mouse. */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
        {canEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${entry.title}`}
            title="Edit"
            className="rounded p-1 text-muted-foreground/60 transition hover:bg-white/[0.05] hover:text-foreground"
            data-testid="memory-row-edit"
          >
            <Pencil className="size-3" />
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${entry.title}`}
            title="Delete"
            className="rounded p-1 text-muted-foreground/60 transition hover:bg-destructive/10 hover:text-destructive"
            data-testid="memory-row-delete"
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </span>
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
      className="flex items-center gap-2 border-t border-white/[0.06] pt-2.5 text-[0.65625rem] text-muted-foreground/70"
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
        className="rounded-md border border-border/60 px-1.5 py-0.5 text-2xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground disabled:opacity-40"
        title="Run one consolidation pass now (expire, merge duplicates, supersede contradictions)" aria-label="Run one consolidation pass now (expire, merge duplicates, supersede contradictions)"
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
  laneLabel,
  laneBusy,
  onToggleLane,
  canRestore,
  restoreBusy,
  onRestore,
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
  /** Profile-lane action label, or null when this store has no `kind` column. */
  laneLabel: string | null;
  laneBusy: boolean;
  onToggleLane: () => void;
  /** A parked (retired) row can be brought back — the one action it needs. */
  canRestore: boolean;
  restoreBusy: boolean;
  onRestore: () => void;
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
  const retired = str(row.status) === 'retired';

  return (
    <div className="space-y-5" data-testid="memory-detail-view">
      {/* The reference's header: a "← Memory" breadcrumb, the entry's name as
          the title, one quiet meta line (last updated · category · source),
          and every action on the right — Edit / Export / the lane / Restore /
          Delete. The old header was a chip row and a "Back to facts" label
          that named the TABLE, not the page the user came from. */}
      <div>
        <button
          type="button"
          onClick={onBack}
          className="mb-2 inline-flex items-center gap-1 text-2xs text-muted-foreground transition hover:text-foreground"
          data-testid="memory-detail-back"
        >
          <ChevronLeft className="size-3" /> Memory
        </button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[1.0625rem] font-semibold leading-snug tracking-tight text-foreground [overflow-wrap:anywhere]">
              {title}
            </h2>
            {entryKey && entryKey !== title && (
              <p className="mt-0.5 truncate text-2xs text-muted-foreground/55" data-testid="memory-detail-key">
                {entryKey}
              </p>
            )}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground/60">
              {updated && (
                <span data-testid="memory-detail-updated-inline">Last updated {updated}</span>
              )}
              {category && <span>· {category}</span>}
              {source && <span data-testid="memory-detail-source">· source: {source}</span>}
              {meta.legacy && <span>· retired writer</span>}
              {retired && <span data-testid="memory-detail-retired">· parked by consolidation</span>}
              {expiresAt && (
                <span
                  className={expired ? 'text-destructive' : 'text-warning'}
                  data-testid="memory-detail-expiry"
                >
                  · {expired ? 'expired' : 'expires'} {expiresAt.slice(0, 10)}
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {!meta.readOnly && meta.editable && !editing && (
              <button
                type="button"
                onClick={onStartEdit}
                className="inline-flex items-center gap-1 rounded-lg border border-border/60 px-2 py-1.5 text-2xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
                data-testid="memory-detail-edit"
              >
                <Pencil className="size-3" /> Edit
              </button>
            )}
            <button
              type="button"
              onClick={onExport}
              className="inline-flex items-center gap-1 rounded-lg border border-border/60 px-2 py-1.5 text-2xs text-muted-foreground transition hover:border-primary/30 hover:text-foreground"
              data-testid="memory-detail-export"
            >
              <Download className="size-3" /> Export
            </button>
            {/* The profile lane moved here from the row's ⋯ menu: it is a
                per-entry decision, not something you do while scanning. */}
            {laneLabel && (
              <button
                type="button"
                onClick={onToggleLane}
                disabled={laneBusy}
                className="inline-flex items-center gap-1 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2 py-1.5 text-2xs text-violet-300 transition hover:bg-violet-500/20 disabled:opacity-40"
                data-testid="memory-detail-toggle-lane"
              >
                <UserRoundCog className="size-3" /> {laneBusy ? 'Saving…' : laneLabel}
              </button>
            )}
            {canRestore && (
              <button
                type="button"
                onClick={onRestore}
                disabled={restoreBusy}
                className="inline-flex items-center gap-1 rounded-lg border border-success/30 bg-success/10 px-2 py-1.5 text-2xs text-success transition hover:bg-success/20 disabled:opacity-40"
                data-testid="memory-detail-restore"
              >
                <ArchiveRestore className="size-3" /> {restoreBusy ? 'Restoring…' : 'Restore'}
              </button>
            )}
            {meta.deletable && (
              <button
                type="button"
                onClick={onDelete}
                className="inline-flex items-center gap-1 rounded-lg border border-destructive/40 px-2 py-1.5 text-2xs text-destructive transition hover:bg-destructive/10"
                data-testid="memory-detail-delete"
              >
                <Trash2 className="size-3" /> Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {editing ? (
        <div className="space-y-3">
          {(meta.editable ?? []).map((f) => (
            <div key={f}>
              <label
                htmlFor={`memory-edit-${f}`}
                className="mb-1 block text-2xs font-medium uppercase tracking-wide text-muted-foreground"
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
        /* Three LABELLED fields, the reference's shape:
         *   Last updated / Summary / Details.
         * It used to render the body as an unlabelled markdown block followed by
         * a run-on line — `source: remember · confidence: 1.0 · created: … ·
         * updated: …` — where four different facts of about the same importance
         * shared one undifferentiated sentence. Labelling them is what makes a
         * memory legible at a glance instead of merely present.
         *
         * `Summary` is skipped when it is the same string as the title (a plain
         * fact's title IS its text), because printing it twice under a heading
         * that already says it is an echo, not information. */
        <div className="space-y-4">
          {summary && summary !== title && (
            <div data-testid="memory-detail-summary">
              <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/70">
                Summary
              </p>
              <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-foreground/90">
                {summary}
              </p>
            </div>
          )}

          {details && (
            <div data-testid="memory-detail-details">
              <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/70">
                Details
              </p>
              <div className="mt-0.5">
                <Markdown content={details} demoteHeadings />
              </div>
            </div>
          )}

          <p className="text-2xs text-muted-foreground/80">
            {[
              source ? `source: ${source}` : '',
              confidence ? `confidence: ${confidence}` : '',
              created ? `created: ${created}` : '',
            ]
              .filter(Boolean)
              .join('  ·  ') || 'No provenance recorded.'}
          </p>
        </div>
      )}
    </div>
  );
}
