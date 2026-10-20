/* ── Memory — human-readable browse of what August stores ────────────── */
/* One flat chronological list, split into named SECTIONS (You / Topics /
 * Notes / Rules), and each row is a hairline row: name · one-line summary ·
 * updated date, with edit and delete on hover. There is no kind chip, no
 * card per row and no meter — the section a row sits in says what kind of
 * thing it is, which is the one thing a chip on every row was saying.
 *
 * The section headers are the reference's shape: bold, ~15 px, with a
 * hairline rule running the full content width beneath them
 * (docs/plans/2026-10-11-ui-reference-capture.md §5, "List view"). The
 * page has NO title of its own — the nav in front of it carries the name,
 * and the reference's memory list opens straight into its section headers.
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
import { ArchiveRestore, ArrowUp, ChevronLeft, ChevronRight, Download, Loader2, Pencil, RefreshCw, Search, SlidersHorizontal, Trash2, UserRoundCog } from 'lucide-react';
import { api } from '@/api/client';
import { PageLoader } from '@/components/PageLoader';
import { Button } from '@/components/ui/button';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { SectionHeader } from '@/components/SectionHeader';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { loadLastModel } from '@/sections/chat/model-display';
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
  /** M-3: the keys this fact REPLACED (the winner's side of the lineage).
   *  A superseded row is kept, not deleted, so "replaces N" is a fact about
   *  this entry and not a guess. */
  replaces: string[];
  /** M-3: the key that replaced THIS fact (the loser's side). */
  supersededBy: string;
  /** M-8: the key this fact conflicts with. A conflict is not a
   *  supersession — it waits for a human, so it gets its own badge. */
  contradicts: string;
  /** M-8: when the fact was last re-stated (empty = never). */
  verifiedAt: string;
}

/** The row's right-hand date, the way the reference reads it: "Updated Aug 21"
 *  this year, "Updated Aug 21, 2025" when the memory is older. */
function shortUpdated(stamp: string): string {
  const t = Date.parse(asUtc(stamp));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const now = new Date();
  // Every getter here is the UTC one ON PURPOSE. The store writes
  // `YYYY-MM-DD HH:MM:SS`, which `asUtc` tags as UTC; formatting that instant in
  // the machine's zone prints the previous calendar day for every user west of
  // Greenwich (measured: a 02:00Z stamp read "Oct 16" in America/New_York).
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return sameYear
    ? `Updated ${month} ${d.getUTCDate()}`
    : `Updated ${month} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** A day, not a timestamp: the detail view's "Last updated" field, where the
 *  reference shows "Aug 21, 2026". The store's own stamp is
 *  `YYYY-MM-DD HH:MM:SS` (UTC, no zone marker) and used to be printed raw into
 *  the header — a storage format in a place meant to read like a date. */
function absoluteDay(stamp: string): string {
  const t = Date.parse(asUtc(stamp));
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
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

/** The `supersedes` column: a JSON array of fact keys in a TEXT column.
 *  Parsed defensively — the column is written by the backend, but a row
 *  that was hand-edited (or written by an older build) must not break the
 *  list. An array that is already parsed passes through. */
function parseKeyList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => str(x)).filter(Boolean);
  const s = str(raw).trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s) as unknown;
    return Array.isArray(parsed) ? parsed.map((x) => str(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function slugify(text: string): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'note';
  // A truncated slug collides: "my dog is called Mittens, she is a..." and
  // "my dog is called Mittens, she hates..." share their first 48 characters,
  // so the second sentence-word overwrote the first through the same key. The
  // hash only appears on slugs that were truncated, so existing keys keep
  // their spelling.
  if (base.length <= 48) return base;
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${base.slice(0, 48)}-${(h >>> 0).toString(36).slice(0, 6)}`;
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
/* A section header — the reference's shape: BOLD, ~15 px, with a hairline
 * rule running the full content width beneath it and generous space above
 * (docs/plans/2026-10-11-ui-reference-capture.md §5, "List view": "Section
 * headers — You, Topics, Areas — are bold, ~15 px, with a hairline rule
 * running the full content width beneath them and generous space above").
 * The old header was a 13 px title with NO rule, and the group header was a
 * tiny uppercase tracked-out label — two grammars for the same thing. */
function MemorySectionHeader({
  title,
  hint,
  hintTestId,
  className,
}: {
  title: string;
  hint?: string;
  hintTestId?: string;
  className?: string;
}) {
  return (
    <div className={cn('mt-6 border-b border-border/60 pb-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[0.9375rem] font-semibold tracking-tight text-foreground">{title}</h3>
        {hint && (
          <span className="truncate text-2xs tabular-nums text-muted-foreground/60" data-testid={hintTestId}>
            {hint}
          </span>
        )}
      </div>
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
    <section className="mt-6" data-testid={testId}>
      <MemorySectionHeader title={title} hint={aside} hintTestId={`${testId}-aside`} className="mt-0" />
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
  /* How many filters are narrowing the list — the disclosure says so, so a
   * filtered list is never silently filtered. */
  const activeFilterCount =
    (catFilter ? 1 : 0) + (srcFilter ? 1 : 0) + (confFilter ? 1 : 0) + (sort !== 'newest' ? 1 : 0);

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
  /* M-9: the store budget is a NUMBER, so it cannot ride the boolean
   * mutation above (one PUT per keystroke). Its own mutation, its own
   * draft, its own Save. */
  const budgetMut = useMutation({
    mutationFn: (patch: Record<string, number>) => api.put('/api/brain/config', patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['brain-config'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Could not save the store budget'),
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
          // M-3 / M-8: the lineage and the trust signals, read off the
          // columns migration 055 added. `supersedes` is a JSON array in a
          // TEXT column, so it is parsed defensively — a row written by
          // something else must not break the list.
          replaces: parseKeyList(row.supersedes),
          supersededBy: str(row.supersededBy),
          contradicts: str(row.contradicts),
          verifiedAt: str(row.verifiedAt),
        });
      }
    }
    out.sort((a, b) => sortTime(b.row, STORE_META[b.store]) - sortTime(a.row, STORE_META[a.store]));
    return out;
  }, [storeA, storeB, storeC, unifiedQa.data, unifiedQb.data, unifiedQc.data]);

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

  /* The composer lives in its own component (MemoryComposeBar) because it does
   * more than one write: it arranges a sentence into ops and then applies them
   * through the manage route, which is the same door this page's delete and
   * edit mutations already use. */
  const onComposerApplied = (deletedKeys: string[]) => {
    invalidate();
    void qc.invalidateQueries({ queryKey: ['memory-workspaces'] });
    // A forgotten entry must not keep its own detail view open over a row that
    // no longer exists.
    if (deletedKeys.length > 0 && detailOpen) {
      const openKey =
        activeStore === 'facts' ? str(detailRow.factKey) : activeStore === 'memory' ? str(detailRow.key) : '';
      if (openKey && deletedKeys.includes(openKey)) {
        setMode('list');
        setSelected(null);
      }
    }
  };

  const cfg = configQ.data?.config;
  /* M-9: the store-budget draft. Seeded from the saved value, and the
   * "dirty" flag compares NUMBERS — a draft of "1500" against a saved 1500
   * is not a change, and a Save button that is live for it would be a lie. */
  const savedBudget = typeof cfg?.factBudget === 'number' ? cfg.factBudget : 0;
  const [budgetDraft, setBudgetDraft] = useState('');
  const effectiveBudget = budgetDraft === '' ? savedBudget : Number(budgetDraft) || 0;
  const budgetDirty = budgetDraft !== '' && effectiveBudget !== savedBudget;
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
    <div className="px-8 py-6">
      {/* No width cap. The reference's memory rows SPAN its content column -
          that is what puts the value column's right edge on one straight
          line down the page, with the date at the far right of every row.
          `max-w-3xl` held the rows at 720px inside a 1080px column, so
          the value column was still a third shorter than the
          reference's and every value truncated. */}
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
      ) : (
        <>
          {/* The composer is shared by the list and a memory's own view — the
              reference keeps it in both, and while you are reading a memory is
              exactly when you know what to change about it. The project panes
              keep their own bar (they write markdown, not facts). */}
          {detailOpen ? (
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

      {/* The page header is the standard one: a bold title and ONE muted
          subtitle. It used to be an <h3> banner whose heading level sat
          ABOVE the <h2> section headers below it — inverted, and a feature
          name doing the work of the page's name. */}
      <SectionHeader
        title="Memory"
        subtitle="Auto-captured memories and key-value notes August has learned, per project or global."
        className="mb-4"
      />

      {/* Import from another AI — the reference's banner position: one
          prominent row at the very top, before the list it feeds. It is a
          ROW, not a card: a filled box above the list was the loudest
          thing on a page whose job is showing what August remembers. */}
      <div
        className="flex items-start justify-between gap-4 border-b border-border/60 pb-4"
        data-testid="memory-import-banner"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Import memory from other AI providers
          </p>
          {/* One line. The reference's page header is a title and a
              subtitle - "Extend ChatGPT with task-specific skills" - and
              nothing more; this banner had three sentences where the
              reference has one, on a page whose job is showing what August
              remembers. */}
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Bring context from another AI provider — drop a Markdown or JSON memory export
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setImportOpen(true)}
          data-testid="memory-import-open"
        >
          Start import
        </Button>
      </div>

      {/* Search, the server-side filters, refresh, export and the bulk
          select. The four server-side selects and the sort sit behind ONE
          disclosure: they were standing in a row across the top of the
          page, louder than the list they filter, and the page's job is
          showing what August remembers. */}
      <div className="flex flex-wrap items-center gap-2 pt-4">
        <div className="relative min-w-44 max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/60" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setUnifiedOffset(0);
              setUnifiedShown(UNIFIED_RENDER);
            }}
            placeholder="Search memory…"
            aria-label="Search memory"
            className="w-full rounded-full border border-border/60 bg-card/60 py-1.5 pl-9 pr-3 text-xs text-foreground outline-none transition focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/50"
            data-testid="memory-search-input"
          />
        </div>
        <details className="group/filters relative">
          <summary
            className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-border/60 bg-card/60 px-2.5 py-1.5 text-2xs text-muted-foreground transition hover:text-foreground [&::-webkit-details-marker]:hidden"
            data-testid="memory-filters"
          >
            <SlidersHorizontal className="size-3" />
            Filters
            {activeFilterCount > 0 && (
              <span className="tabular-nums text-muted-foreground/70">· {activeFilterCount}</span>
            )}
          </summary>
          <div className="absolute left-0 top-full z-30 mt-1.5 flex w-64 flex-col gap-2 rounded-lg border border-border/60 bg-card p-3 shadow-xl">
            {/* The app's own listbox, not a native <select>: a native control
                draws the OS's own chrome in the middle of a themed panel,
                which is the reason SettingsSelect exists at all. */}
            <div className="block">
              <span className="text-2xs text-muted-foreground/70">Category</span>
              <div className="mt-1" data-testid="memory-category-filter">
                <SettingsSelect
                  value={catFilter}
                  onChange={(v) => {
                    setCatFilter(v);
                    setUnifiedOffset(0);
                  }}
                  options={[
                    { value: '', label: 'All categories' },
                    ...['general', 'user', 'project', 'workflow', 'preference'].map((c) => ({
                      value: c,
                      label: c,
                    })),
                  ]}
                  aria-label="Filter by category"
                  size="sm"
                  className="w-full"
                />
              </div>
            </div>
            <div className="block">
              <span className="text-2xs text-muted-foreground/70">Source</span>
              <div className="mt-1" data-testid="memory-source-filter">
                <SettingsSelect
                  value={srcFilter}
                  onChange={(v) => {
                    setSrcFilter(v);
                    setUnifiedOffset(0);
                  }}
                  options={[
                    { value: '', label: 'All sources' },
                    ...['remember', 'user', 'extracted', 'lesson'].map((s) => ({ value: s, label: s })),
                  ]}
                  aria-label="Filter by source"
                  size="sm"
                  className="w-full"
                />
              </div>
            </div>
            <div className="block">
              <span className="text-2xs text-muted-foreground/70">Confidence</span>
              <div className="mt-1" data-testid="memory-confidence-filter">
                <SettingsSelect
                  value={confFilter}
                  onChange={(v) => {
                    setConfFilter(v);
                    setUnifiedOffset(0);
                  }}
                  options={[
                    { value: '', label: 'All confidence' },
                    { value: 'high', label: 'high' },
                    { value: 'medium', label: 'medium' },
                    { value: 'low', label: 'low' },
                  ]}
                  aria-label="Filter by confidence"
                  size="sm"
                  className="w-full"
                />
              </div>
            </div>
            <div className="block">
              <span className="text-2xs text-muted-foreground/70">Sort</span>
              <div className="mt-1" data-testid="memory-sort">
                <SettingsSelect
                  value={sort}
                  onChange={(v) => {
                    setSort(v);
                    setUnifiedOffset(0);
                  }}
                  options={SORTS.map((s) => ({ value: s.value, label: s.label }))}
                  aria-label="Sort order"
                  size="sm"
                  className="w-full"
                />
              </div>
            </div>
          </div>
        </details>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void storesQ.refetch();
            void unifiedQa.refetch();
            void unifiedQb.refetch();
            void workspacesQ.refetch();
          }}
          title="Refresh"
          aria-label="Refresh memory stores"
          data-testid="memory-refresh"
        >
          <RefreshCw className={cn('size-3', (unifiedQa.isFetching || unifiedQb.isFetching) && 'animate-spin')} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={exportStore}
          disabled={flatEntries.length === 0}
          title="Export as Markdown"
          aria-label="Export as Markdown"
          data-testid="memory-export"
        >
          <Download className="size-3" /> Export
        </Button>
        {/* C-6: bulk mode is opt-in — the default row carries no checkbox,
            because the reference's row is name/description/date and nothing
            else. The mode reveals the checkboxes and the bulk bar. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setSelectMode((v) => !v);
            setChecked(new Set());
          }}
          aria-pressed={selectMode}
          className={cn(selectMode && 'text-foreground')}
          data-testid="memory-select-mode"
        >
          {selectMode ? 'Done' : 'Select'}
        </Button>
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
        <div className="pt-1">
          {/* The spacing between sections is the HEADER's (the reference's
              "generous space above"), not a second margin on the container —
              two gaps stacked read as a hole. */}
          {/* You — the profile lane. These facts ride along on every turn
              instead of being recalled by keyword, so the section says so
              once instead of stamping a chip on every row. */}
          {sections.you.length > 0 && (
            <section data-testid="memory-section-you">
              {/* The reference's section headers are BARE: "You", "Topics",
                  "Areas" and nothing on the right. This one carried a
                  thirteen-word sentence where a count belongs, and the
                  "Topics" header beside it carried a bare number - so two
                  headers in the same list were set in two different
                  languages. The count is the metadata; the sentence moved
                  to the one muted line under the section, where the
                  reference keeps its occasional asides. */}
              <MemorySectionHeader title="You" hint={`${sections.you.length}`} />
              <div className="divide-y divide-border/60">
                {sections.you.map((e) => rowFor(e))}
              </div>
              {/* ONE muted line, not two. The reference's list is a list:
                  the rows, and nothing between them that is not a row. A
                  two-line paragraph under the first section read as a
                  paragraph in the middle of a table, and it repeated the
                  header's own sentence. What is left is the part that is
                  NOT obvious from the rows themselves: that a parked row is
                  recalled by nothing. */}
              <p className="pt-1.5 text-[0.65625rem] leading-relaxed text-muted-foreground/60" data-testid="memory-profile-explainer">
                Injected every turn; a parked row is recalled by nothing.
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
                  <div className="divide-y divide-border/60">
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
              <div className="divide-y divide-border/60">
                {sections.notes.map((e) => rowFor(e))}
              </div>
            </section>
          )}

          {/* Rules — legacy lessons, read-only but deletable. */}
          {sections.rules.length > 0 && (
            <section data-testid="memory-section-rules">
              <MemorySectionHeader title="Rules" hint="retired writer · kept for recall" />
              <div className="divide-y divide-border/60">
                {sections.rules.map((e) => rowFor(e))}
              </div>
            </section>
          )}

          {filteredEntries.length === 0 && (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">
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

      {/* Project memories — the reference's "Areas" in all but name: scoped,
          durable, and browsed with the same row. They sit ABOVE the health
          footer and the behaviour switches because they are content; the page
          used to put them last, 1.2k pixels down a 663px window, so the one
          group you could only reach by scrolling past every control was the
          one about your actual projects. */}
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
            No project memories yet.
          </p>
        ) : (
          <div className="divide-y divide-border/60" data-testid="memory-project-rows">
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
        <div className="divide-y divide-border/60">
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
      {/* M-9: the store budget. 0 = no budget, which is the shipped state —
          the pass that enforces it is the only automatic curation in the
          store, so it waits until someone asks for it. A number cannot ride
          the toggles above (a PUT per keystroke), so it has its own draft
          and its own Save. */}
      <div className="mt-3 border-t border-border/60 pt-3" data-testid="memory-budget-group">
        <label
          htmlFor="memory-fact-budget"
          className="text-sm font-medium text-foreground"
        >
          Store budget
        </label>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          How many active memories August may keep. Over the budget, the
          consolidation pass archives the weakest ones — the least confident,
          least used, oldest — and keeps them restorable rather than deleting
          them. 0 (the default) means no budget: nothing is ever archived on
          its own.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <input
            id="memory-fact-budget"
            type="number"
            min={0}
            max={100000}
            aria-label="Store budget (active memories)"
            data-testid="memory-fact-budget-input"
            value={budgetDraft}
            onChange={(e) => setBudgetDraft(e.target.value)}
            className="w-28 rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-right text-xs text-foreground outline-none focus:border-primary/40"
          />
          <span className="text-2xs text-muted-foreground">
            {budgetDraft === '' ? 'no budget' : `${budgetDraft} memories`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!budgetDirty || budgetMut.isPending}
            onClick={() => {
              const next = Math.max(0, Math.min(100000, Math.round(Number(budgetDraft) || 0)));
              budgetMut.mutate({ factBudget: next });
            }}
            data-testid="memory-fact-budget-save"
          >
            {budgetMut.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {budgetMut.isError ? (
          <p role="alert" className="mt-1.5 text-2xs text-danger-fg" data-testid="memory-fact-budget-error">
            Could not save the store budget: {budgetMut.error?.message}
          </p>
        ) : null}
      </div>
      </MemoryGroup>

      <BrainBackupsCard />
            </>
          )}

          <MemoryComposeBar
            onApplied={onComposerApplied}
            findEntry={(key) => flatEntries.find((e) => e.id === key)}
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
    (onClick ? ' cursor-pointer transition hover:bg-muted/40' : '');
  const body = (
    <>
      {/* The same grammar as the list rows: a fixed-width name, a value at
          the SAME type size, and a muted third column. This row used to be
          two sizes of name, a smaller detail and a smaller meta — a second
          grammar in the same panel. */}
      <span className="flex min-w-0 flex-1 items-baseline gap-3">
        <span className="w-[13rem] shrink-0 truncate text-[0.8125rem] font-medium text-foreground/90">
          {title}
        </span>
        {detail && (
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground/70" title={detail}>
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
              className="w-full border-b border-border/60 bg-transparent py-1.5 pl-6 pr-2 text-[0.78125rem] text-foreground outline-none transition focus:border-primary/40"
              data-testid="memory-project-search"
            />
          </div>

          <section className="border-t border-border/60 pt-2" data-testid="memory-project-files">
            <h3 className="pb-0.5 text-[0.65625rem] font-semibold uppercase tracking-widest text-muted-foreground/55">
              Files
            </h3>
            <div className="divide-y divide-border/60">
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

          <section className="border-t border-border/60 pt-2" data-testid="memory-project-entries">
            <h3 className="pb-0.5 text-[0.65625rem] font-semibold uppercase tracking-widest text-muted-foreground/55">
              Entries
            </h3>
            <div className="divide-y divide-border/60">
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
      className="sticky bottom-0 -mx-8 mt-6 border-t border-border/60 bg-background/95 px-8 py-3 backdrop-blur"
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
          className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
          data-testid={`${testId}-submit`}
        >
          <ArrowUp className="size-3" />
        </button>
      </div>
    </div>
  );
}


/* ── The composer: "tell August what to change" ──────────────────────── */

/** One operation the arrange door proposed. Same vocabulary the AI-arranged
 *  import uses, so both doors write through the same two backend routes.
 *  `previous` is the memory an update/delete would replace — the instruction
 *  door attaches it so the strip can name what is being changed. */
interface MemoryOp {
  action: 'add' | 'update' | 'delete';
  key: string;
  value: string;
  category: string;
  previous: string;
}

const OP_WORD: Record<MemoryOp['action'], string> = {
  add: 'new',
  update: 'change',
  delete: 'forget',
};

/** The arrange endpoint always answers with an `operations` array. Anything
 *  else — a missing field, a non-array, a 503 from a backend that could not
 *  resolve a model — is NOT an arrangement, and null says so: the caller then
 *  saves the sentence as written rather than pretending a model read it. */
function asOps(raw: unknown): MemoryOp[] | null {
  if (!Array.isArray(raw)) return null;
  const ops: MemoryOp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const action = str(rec.action).toLowerCase();
    const key = str(rec.key).trim();
    if (!key) continue;
    if (action !== 'add' && action !== 'update' && action !== 'delete') continue;
    ops.push({
      action,
      key,
      value: str(rec.value),
      category: str(rec.category) || 'general',
      previous: str(rec.previous),
    });
  }
  return ops;
}

/** The reference's bottom bar, with its "what to CHANGE" job.
 *
 *  The bar used to be an append-only form: whatever you typed became one more
 *  memory under `user:<slug-of-the-sentence>`, so "actually my dog is called
 *  Mittens" bought a second memory rather than correcting the first. This one
 *  hands the sentence to the same arrange door the AI import uses
 *  (`mode: 'instruction'`) and writes the ops it returns through the same
 *  `memory/manage` routes the memory tools use — so the model organizes, and
 *  the doors stay one.
 *
 *  Two deliberate safety choices, both unlike the reference (which saves
 *  whatever the model decided, silently):
 *
 *  * New memories save straight away — one Enter, as before. Anything that
 *    REWRITES or REMOVES an existing memory is shown first, as a plan you
 *    apply or discard, because a wrong `update` silently replaces something
 *    you wrote and a wrong `delete` is unrecoverable from this page.
 *  * A sentence the model reads and judges to hold nothing durable is NOT
 *    quietly dropped: the text stays in the box and a second send keeps it
 *    verbatim. The model's judgement is a suggestion, never the last word on
 *    what the user meant.
 *
 *  When nothing can arrange the sentence — no model configured, the gateway
 *  refused, a response with no `operations` at all — the door still works
 *  exactly as it used to: the sentence is stored as written under
 *  `user:<slug>`, and the placeholder says which door this install has.
 */
function MemoryComposeBar({
  onApplied,
  findEntry,
  testId = 'memory-add',
}: {
  /** Re-run the page's queries; `deletedKeys` lets the caller close a detail
   *  view whose own entry was just forgotten. */
  onApplied: (deletedKeys: string[]) => void;
  /** The row a proposed key names, when the pane has it loaded. It answers the
   *  two questions the write path cannot guess: which STORE the key lives in
   *  (the pane merges the facts store with the KV notes store, and a write to
   *  the notes store needs `store: 'memory'`), and whether an `add` is really a
   *  create — an `add` naming a key that already exists is an overwrite, and an
   *  overwrite is exactly what the review strip exists for. */
  findEntry: (key: string) => FlatEntry | undefined;
  testId?: string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // `said` travels with the plan: a plan belongs to the sentence that produced
  // it, and the strip has to be able to quote that sentence back.
  const [plan, setPlan] = useState<{ ops: MemoryOp[]; by: string; said: string } | null>(null);
  // Set when the model read the sentence and found nothing durable: pressing
  // send again stores it verbatim, so a model's judgement call can never eat
  // something the user meant to keep.
  const [verbatim, setVerbatim] = useState(false);
  // The last model the chat used — the same resolution the AI import dialog
  // makes. Absent, the change door is unavailable and the bar says so. Read
  // once per mount: re-parsing localStorage on every render bought nothing,
  // and a model picked elsewhere arrives with the next mount anyway.
  const model = useMemo(() => loadLastModel(), []);

  /** Apply a plan through the same `memory/manage` doors this page's row
   *  actions and the memory tools use.
   *
   *  Three things this must get right, each one measured wrong before:
   *
   *  * An `update` is a PARTIAL write (`partial: true`). `manage set` is an
   *    upsert whose SQL rewrites `expires_at` and `status`, so approving
   *    "change the value" also cleared a TTL and revived a retired row — a
   *    change the user never saw and could not have approved.
   *  * The destination store is resolved from the row the key names: the pane
   *    merges the facts store with the KV notes store, and a KV write needs
   *    `store: 'memory'` or the "fix the note" instruction lands as a new fact.
   *  * The receipt is read back, never assumed (`deleted`/`ok`): this endpoint
   *    answered `ok: true` for a key that was already gone, so the toast could
   *    report "1 forgotten" about nothing at all.
   *
   *  It also returns the ops that FAILED, because the caller used to clear the
   *  box and drop the strip no matter what: a 409 (a cross-scope overwrite, or
   *  secret-shaped text — `memory_store/rest.py` refuses both) deleted the
   *  sentence and the plan from the only place that could retry them.
   */
  const writeOps = async (
    ops: MemoryOp[],
    lookup: (key: string) => FlatEntry | undefined,
  ): Promise<{ failed: MemoryOp[] }> => {
    let saved = 0;
    let forgotten = 0;
    let gone = 0;
    const failed: MemoryOp[] = [];
    const deletedKeys: string[] = [];
    for (const op of ops) {
      const entry = lookup(op.key);
      const store = entry?.store === 'memory' ? 'memory' : undefined;
      try {
        if (op.action === 'delete') {
          const res = await api.post<{ deleted?: boolean; ok?: boolean }>(
            '/api/august/memory/manage',
            { action: 'delete', key: op.key, ...(store ? { store } : {}) },
          );
          deletedKeys.push(op.key);
          // `deleted` is the facts door; `ok` is the notes door's row count.
          if ((res?.deleted ?? res?.ok ?? true) === false) gone += 1;
          else forgotten += 1;
        } else {
          await api.post('/api/august/memory/manage', {
            action: 'set',
            key: op.key,
            value: op.value,
            category: op.category,
            source: 'user',
            ...(op.action === 'update' && entry && !store ? { partial: true } : {}),
            ...(store ? { store } : {}),
          });
          saved += 1;
        }
      } catch {
        failed.push(op);
      }
    }
    onApplied(deletedKeys);
    if (failed.length > 0) {
      toast.error(
        `${failed.length} of ${ops.length} change${ops.length === 1 ? '' : 's'} failed — nothing was cleared`,
      );
    } else if (saved === 1 && forgotten === 0 && gone === 0) {
      toast.success('Memory saved');
    } else {
      const bits = [
        saved ? `${saved} saved` : '',
        forgotten ? `${forgotten} forgotten` : '',
        gone ? `${gone} already gone` : '',
      ].filter(Boolean);
      toast.success(bits.join(' · ') || 'Nothing changed');
    }
    return { failed };
  };

  /** Store the sentence as its own memory, the way the bar always could.
   *  `why` distinguishes the two ways the door ends up here, so the receipt
   *  says which door actually ran — a sentence like "my dog is now called
   *  Mittens" stored verbatim is a fact where a correction was meant, and the
   *  user is the only one who can tell that apart from a plain note. */
  const saveAsWritten = async (said: string, why: 'unavailable' | 'empty') => {
    try {
      await api.post('/api/august/memory/manage', {
        action: 'set',
        key: `user:${slugify(said)}`,
        value: said,
        source: 'user',
      });
      setText('');
      setVerbatim(false);
      onApplied([]);
      if (why === 'unavailable') {
        toast.warning('Saved as written — no model could arrange it');
      } else {
        toast.success('Kept as written');
      }
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not save memory');
    }
  };

  const submit = async () => {
    const said = text.trim();
    if (!said || busy) return;
    if (verbatim) {
      setBusy(true);
      await saveAsWritten(said, 'empty');
      setBusy(false);
      return;
    }
    setBusy(true);
    setPlan(null);
    let ops: MemoryOp[] | null = null;
    let by = '';
    try {
      const res = await api.post<{
        operations?: unknown;
        model?: string;
        provider?: string;
        truncated?: boolean;
      }>('/api/august/memory/import/ai', {
        text: said,
        mode: 'instruction',
        model: model?.id ?? '',
        provider: model?.provider ?? '',
      });
      ops = asOps(res?.operations ?? null);
      by = [res?.model, res?.provider].filter(Boolean).join(' · ');
      // The endpoint reads a bounded prefix (8,000 characters for one
      // instruction). It used to cut the tail silently while this bar cleared
      // the box, so half an instruction could vanish with no trace.
      if (res?.truncated) {
        toast.warning(
          'Only the first 8,000 characters were read — the rest of that sentence was ignored.',
        );
      }
    } catch {
      ops = null;
    }
    if (ops === null) {
      await saveAsWritten(said, 'unavailable');
      setBusy(false);
      return;
    }
    if (ops.length === 0) {
      setVerbatim(true);
      toast.message('Nothing durable in that sentence — press send again to keep it as written.');
      setBusy(false);
      return;
    }
    // Straight to the store ONLY when every op is a create. An `add` naming a
    // key that already exists is an upsert — an overwrite of a memory the user
    // wrote — and the backend only coerces the phantom `update` in the other
    // direction, so the review strip has to see it.
    if (ops.every((op) => op.action === 'add' && !findEntry(op.key))) {
      const { failed } = await writeOps(ops, findEntry);
      // A failed write keeps BOTH the sentence and the ops that did not land:
      // clearing them left a toast as the only trace of what the user asked
      // for (measured on the 409 the secret and cross-scope refusals raise).
      if (failed.length === 0) setText('');
      else setPlan({ ops: failed, by, said });
      setBusy(false);
      return;
    }
    setPlan({ ops, by, said });
    setBusy(false);
  };

  return (
    <div
      className="sticky bottom-0 -mx-8 mt-6 border-t border-border/60 bg-background/95 px-8 py-3 backdrop-blur"
      data-testid={testId}
    >
      {plan && (
        <div
          className="mb-2 rounded-xl border border-border/60 bg-card/80 p-3"
          data-testid="memory-plan"
          /* The strip appears asynchronously, after a model round-trip, and
             nothing else on the page announces it — a screen-reader user got
             no signal that a plan was waiting for a decision. */
          role="status"
          aria-live="polite"
        >
          <p className="text-2xs text-muted-foreground/70" data-testid="memory-plan-count">
            {plan.ops.length === 1 ? '1 change' : `${plan.ops.length} changes`} to review
            {plan.by ? ` · arranged by ${plan.by}` : ''}
          </p>
          {/* The sentence the plan answers. Without it a plan that outlived a
              retyped box looked like it belonged to whatever was typed next. */}
          {plan.said && (
            <p
              className="mt-0.5 truncate text-2xs italic text-muted-foreground/55"
              title={plan.said}
              data-testid="memory-plan-said"
            >
              “{plan.said}”
            </p>
          )}
          <ul className="mt-1.5 max-h-40 space-y-1.5 overflow-y-auto">
            {plan.ops.map((op, i) => (
              <li
                key={`${op.action}:${op.key}:${i}`}
                className="text-[0.71875rem]"
                data-testid="memory-plan-op"
                data-action={op.action}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'shrink-0 rounded px-1 py-0.5 text-[0.65625rem] font-medium',
                      op.action === 'delete'
                        ? 'bg-destructive/15 text-destructive'
                        : op.action === 'update'
                          ? 'bg-warning/15 text-warning'
                          : 'bg-primary/15 text-primary',
                    )}
                  >
                    {OP_WORD[op.action]}
                  </span>
                  <span className="shrink-0 font-medium text-foreground/90">{op.key}</span>
                </div>
                {/* What is being replaced, struck through, above what replaces
                    it. Without it a `delete` op is a key name and nothing else
                    — the user would be approving "forget old-address" without
                    seeing the memory that goes. */}
                {op.previous && (
                  <p
                    className="truncate text-muted-foreground/50 line-through"
                    title={op.previous}
                    data-testid="memory-plan-previous"
                  >
                    <span className="sr-only">Replacing: </span>
                    {op.previous}
                  </p>
                )}
                {op.value && (
                  <p className="truncate text-foreground/85" title={op.value} data-testid="memory-plan-value">
                    <span className="sr-only">With: </span>
                    {op.value}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPlan(null)}
              className="rounded-lg border border-border px-2.5 py-1 text-2xs text-foreground transition hover:bg-accent"
              data-testid="memory-plan-discard"
            >
              Discard
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const { ops, by, said } = plan;
                setBusy(true);
                void writeOps(ops, findEntry).then(({ failed }) => {
                  // A partial failure keeps the ops that did not land (and the
                  // sentence that asked for them); only a clean run clears.
                  if (failed.length === 0) {
                    setPlan(null);
                    setText('');
                  } else {
                    setPlan({ ops: failed, by, said });
                  }
                  setBusy(false);
                });
              }}
              className="rounded-lg bg-primary px-2.5 py-1 text-2xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
              data-testid="memory-plan-apply"
            >
              {plan.ops.length === 1 ? 'Apply change' : `Apply ${plan.ops.length} changes`}
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/60 px-3 py-2">
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setVerbatim(false);
            // The plan belongs to the sentence that produced it; editing the
            // text retires it, so a stale Apply cannot write ops the box no
            // longer shows.
            setPlan(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim() && !busy) void submit();
          }}
          placeholder={
            model ? 'Tell August what to change…' : 'Tell August what to remember…'
          }
          aria-label="Tell August what to change"
          title={
            model
              ? `Memories are arranged by ${model.id}, then saved`
              : 'Chat once to pick a model — then this bar can also rewrite and forget memories'
          }
          className="min-w-0 flex-1 rounded-md bg-transparent text-[0.78125rem] text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-primary/50"
          data-testid={`${testId}-input`}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
          aria-label="Save memory"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
          data-testid={`${testId}-submit`}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <ArrowUp className="size-3" />}
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
      className={cn(
        // The reference's row reads as a row: a full-width highlight under the
        // cursor is what pairs with the hover-only actions (they used to fade
        // in over a transparent row, so nothing said which line they belonged
        // to). The negative margin lets the highlight outrun the text column
        // while keeping every column aligned row to row.
        'group relative -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition hover:bg-muted/40',
        entry.expired && 'opacity-50',
      )}
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
        {/* The reference's row is THREE COLUMNS at ONE type size: the name
            and the value are set the same, and only the date is muted. The
            name column is a FIXED width so every value in the list starts
            at the same x - that is what makes the list a table you can
            scan down instead of a ragged edge. It was 38% of the row, which
            in the reference's proportions is three times too wide: the
            value lost a third of its width to a column nothing needed. */}
        <span className="min-w-0 w-[13rem] shrink-0 truncate text-[0.8125rem] font-medium text-foreground/90">
          {entry.title}
        </span>
        {detail && (
          <span className="hidden min-w-0 flex-1 truncate text-[0.8125rem] text-foreground/70 sm:block">
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
      {/* M-3 / M-8: the lineage. A fact that REPLACED others says so (the
          losers are kept, not deleted — so this is a fact about the entry,
          not a guess), a fact that was REPLACED says so too, and a genuine
          CONFLICT says so instead: a contradiction waits for a human, which
          is not the same thing as being an older version of something. */}
      {entry.contradicts ? (
        <span
          className="shrink-0 text-2xs text-warning"
          title={`Conflicts with "${entry.contradicts}" — two entries that cannot both be right.`}
          data-testid="memory-conflict-badge"
        >
          conflict
        </span>
      ) : entry.supersededBy ? (
        <span
          className="shrink-0 text-2xs text-muted-foreground/60"
          title={`Replaced by "${entry.supersededBy}" — kept, not deleted, so it can be restored.`}
          data-testid="memory-superseded-badge"
        >
          superseded
        </span>
      ) : entry.replaces.length > 0 ? (
        <span
          className="shrink-0 text-2xs text-muted-foreground/60"
          title={`Replaces ${entry.replaces.join(', ')} — those entries are kept and are restored if this one is deleted.`}
          data-testid="memory-replaces-badge"
        >
          replaces {entry.replaces.length}
        </span>
      ) : null}
      <span
        className="shrink-0 text-2xs tabular-nums text-muted-foreground/55 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
        title={absoluteDate(asUtc(entry.updated)) || entry.updated}
        data-testid="memory-row-updated"
      >
        {shortUpdated(entry.updated)}
      </span>
      {/* Hover actions; focus-within keeps them reachable without a mouse.
          They REPLACE the timestamp, the way the reference's rows do ("the
          row fills lighter, and a pencil + trash icon pair appears at the far
          right, replacing the timestamp"). The date fades out under them so
          the two never overlap. */}
      <span className="absolute right-2 flex shrink-0 items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
        {canEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${entry.title}`}
            title="Edit"
            className="rounded p-1 text-muted-foreground/60 transition hover:bg-muted/60 hover:text-foreground"
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
      className="flex items-center gap-2 border-t border-border/60 pt-2.5 text-[0.65625rem] text-muted-foreground/70"
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

  /* The quiet facts about the entry, as one line of separated items. This used
   * to lead with the raw store stamp (`Last updated 2026-10-16 15:01:10`) and
   * run four different facts together; the stamp is now the labelled field
   * below, where the reference puts it, and this line carries the rest. */
  const metaBits: Array<{ key: string; node: ReactNode }> = [];
  if (category) metaBits.push({ key: 'category', node: <span>{category}</span> });
  if (meta.legacy) metaBits.push({ key: 'legacy', node: <span>retired writer</span> });
  if (retired) {
    metaBits.push({
      key: 'parked',
      node: <span data-testid="memory-detail-retired">parked by consolidation</span>,
    });
  }
  if (expiresAt) {
    metaBits.push({
      key: 'expiry',
      node: (
        <span
          className={expired ? 'text-destructive' : 'text-warning'}
          data-testid="memory-detail-expiry"
        >
          {expired ? 'expired' : 'expires'} {expiresAt.slice(0, 10)}
        </span>
      ),
    });
  }

  return (
    <div className="space-y-5" data-testid="memory-detail-view">
      {/* The reference's header: a "← Memory" breadcrumb, the entry's name as
          the title, a quiet meta line, and the actions. The actions sit on the
          breadcrumb's row rather than beside the title: five labelled buttons
          (Edit / Export / the lane / Restore / Delete) measured 236px of title
          in a 614px column, so a real entry name wrapped to three lines to make
          room for chrome. The title now owns the full column, and the cluster
          wraps to its own line when the column is narrow. */}
      <div className="flex flex-col">
        {/* DOM order is title → breadcrumb+actions, VISUAL order is the
            reference's (breadcrumb row on top). A screen reader reads the entry's
            name before it reads the buttons that act on it; before this, the
            first thing announced was "Delete". `order-*` on a flex column keeps
            both true at once, and the layout test that pinned DOM-before as a
            proxy for visually-above is gone with the rest of the suite. */}
        <div className="min-w-0 order-2">
          {/* The title, and then the reference's FIELDS - Last updated,
              Summary, Details - with nothing wedged between them. The key
              and the provenance line used to sit here, under the title,
              which put two lines of bookkeeping in front of the one field
              a reader came for. They moved to the bottom, with the rest of
              the provenance, where a footnote belongs. */}
          <h2 className="text-[1.25rem] font-semibold leading-snug tracking-tight text-foreground [overflow-wrap:anywhere]">
            {title}
          </h2>
        </div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 order-1">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 text-2xs text-muted-foreground transition hover:text-foreground"
            data-testid="memory-detail-back"
          >
            <ChevronLeft className="size-3" /> Memory
          </button>
          <div
            className="flex flex-wrap items-center justify-end gap-1.5"
            data-testid="memory-detail-actions"
          >
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
                className="inline-flex items-center gap-1 rounded-lg border border-primary/30 bg-primary/10 px-2 py-1.5 text-2xs text-primary transition hover:bg-primary/20 disabled:opacity-40"
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
        /* The reference's field list: Last updated / Summary / Details, as
         * labelled fields rather than one run-on provenance line.
         *
         * `Last updated` was the raw store stamp inline in the header
         * ("Last updated 2026-10-16 15:01:10"); the reference shows a date
         * ("Aug 21, 2026") under a label, and the exact stamp still rides in
         * the tooltip for anyone who needs the clock.
         *
         * Labels are sentence case at body-adjacent size. They were 10px
         * uppercase micro-caps, the house style for a *chrome* label — but a
         * memory's fields are content, and the reference sets them as words a
         * person reads, not as taxonomy.
         *
         * `Summary` is skipped when it is the same string as the title (a plain
         * fact's title IS its text), because printing it twice under a heading
         * that already says it is an echo, not information. */
        <div className="space-y-4">
          {updated && (
            <div data-testid="memory-detail-updated">
              <p className="text-[0.75rem] font-medium text-muted-foreground/60">Last updated</p>
              <p
                className="mt-0.5 text-[0.8125rem] text-foreground/90"
                title={absoluteDate(asUtc(updated)) || updated}
              >
                {absoluteDay(updated) || updated}
              </p>
            </div>
          )}

          {summary && summary !== title && (
            <div data-testid="memory-detail-summary">
              <p className="text-[0.75rem] font-medium text-muted-foreground/60">Summary</p>
              <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-foreground/90">
                {summary}
              </p>
            </div>
          )}

          {details && (
            <div data-testid="memory-detail-details">
              <p className="text-[0.75rem] font-medium text-muted-foreground/60">Details</p>
              <div className="mt-0.5">
                <Markdown content={details} demoteHeadings />
              </div>
            </div>
          )}

          {/* The provenance footnote, with the key and the entry's own
              badges. `source` appears ONCE now: it was in the header line
              AND in this line, so the same fact was printed twice a
              screen apart. */}
          <div
            className="space-y-1 border-t border-border/40 pt-3"
            data-testid="memory-detail-provenance"
          >
            {entryKey && entryKey !== title && (
              <p className="truncate font-mono text-2xs text-muted-foreground/55" data-testid="memory-detail-key">
                {entryKey}
              </p>
            )}
            {metaBits.length > 0 && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground/60">
                {metaBits.map((bit, i) => (
                  <span key={bit.key} className="inline-flex items-center gap-2">
                    {i > 0 && (
                      <span aria-hidden className="text-muted-foreground/35">
                        ·
                      </span>
                    )}
                    {bit.node}
                  </span>
                ))}
              </p>
            )}
            <p
              className="text-2xs text-muted-foreground/80"
              title={[str(row.createdAt), str(row.updatedAt)].filter(Boolean).join('  →  ')}
            >
              {[
                source ? `source: ${source}` : '',
                confidence ? `confidence: ${confidence}` : '',
                created ? `created ${absoluteDay(created) || created}` : '',
              ]
                .filter(Boolean)
                .join('  ·  ') || 'No provenance recorded.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
