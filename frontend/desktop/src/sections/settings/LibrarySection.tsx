/* ── Library — Memory and Skills, one list-and-detail pattern ───────── */
/* The port of `docs/design/signal-desk-complete.html`'s `#scaleDoc` screen:
 * the browse surface built for a 1,284-fact / 214-skill store. Tabs carry the
 * counts, four stat cards state what the library holds, one toolbar does
 * search + type + scope + sort, rows are hairlines grouped under a sticky
 * scope head, and a sticky detail pane answers "what is this thing and what
 * can I do to it". No card per row, no meter, no wall of boxes.
 *
 * Every number and every row here comes from a real door, and where the
 * mockup invented one it was cut rather than faked:
 *
 *  • "Updates: 6 available" — no endpoint reports an update for an installed
 *    skill, so there is no Updates filter, no Update pill and no Update
 *    button. The card that would have held it counts BUNDLED skills, which
 *    `/api/skills` does report through each row's `scope`.
 *  • "Open folder" — there is no reveal-in-explorer door, so the detail pane
 *    does not offer one.
 *  • the row's "Retire" action — the store refuses a human-initiated
 *    retirement (`status may only be set to 'active'`; parking a row is the
 *    consolidation pass's decision), so the pane offers RESTORE for a retired
 *    fact and nothing in the other direction. The Retired stat card is a
 *    server COUNT, asked with `?status=retired`, not a page-local tally.
 *  • "Marketplace / Installed / Project" sources — the real scopes are
 *    `bundled`, the agent layer, `project` and `bot`, taken from
 *    `skill_service._skillRoots`, the root list that decides the label.
 *  • The mockup's "Project" facts do not exist as database rows. August's
 *    project memory is the `<workspace>/.aug/memory` markdown layer, reached
 *    through `/api/august/memory/manage {action:'list', scope:'project'}`, and
 *    those entries ARE listed here — as Notes, scoped to the workspace name —
 *    because pretending they are rows of the facts store would describe a
 *    scope the write door refuses.
 *
 * The rich tools that used to live on these two pages (the brain-config
 * switches, the store budget, consolidation, backups, the SKILL.md editor and
 * the trash roster) are NOT deleted: they ride behind the "All tools" door in
 * each panel head, which navigates to the hidden `memory-tools` / `skills-tools`
 * sections. One door per capability, one surface per browse. */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BookOpen,
  Download,
  Layers,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Wrench,
} from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ImportMemoryDialog } from './ImportMemoryDialog';
import { SkillPacksPanel } from './SkillPacksPanel';
import { SkillVersionsPanel } from './SkillVersionsPanel';
import { cn, timeAgo } from '@/lib/utils';
import {
  FACTS_DETAILS_FIELD,
  FACTS_VALUE_FIELD,
  absoluteDay,
  composeFactValue,
  parseFactValue,
  shortUpdated,
  stampTime,
  summarizeKvValue,
} from '@/lib/memory-values';
import type { SettingsSection } from '@/settings/settings-registry';

type Row = Record<string, unknown>;

/* ── shared chrome ─────────────────────────────────────────────────── */

/** One table's column tracks. Header and rows pass the SAME string, so a
 *  cell can never land under the wrong heading.
 *
 *  Two tiers, keyed to the width this page can actually have: the Settings
 *  content column caps at 1024px, and at ≥1500 the detail pane takes 352px of
 *  it back, so the list panel is never wider than ~876 and is ~660 beside the
 *  detail. The mockup's own 1120/720 tiers were measured against a
 *  full-window page with no chrome — using those numbers here clipped the
 *  panel at 960 (measured: "All tools" painted off the card edge).
 *
 *  The Scope column is the one piece of the mockup dropped on purpose: every
 *  row already sits under a group head that names its scope, so the column
 *  repeated the head, and "Last used" is the information nothing else carries. */
const MEM_COLS =
  'grid grid-cols-[22px_minmax(0,1fr)_26px] min-[1204px]:grid-cols-[22px_minmax(0,1fr)_78px_88px_26px]';
const SKILL_COLS =
  'grid grid-cols-[22px_minmax(0,1fr)_26px] min-[1204px]:grid-cols-[22px_minmax(0,1fr)_52px_60px_78px_26px]';

/** The columns the narrow tier hides — and the track collapse above matches. */
const CELL = 'hidden min-[1204px]:block min-[1204px]:truncate';

const MICRO_LABEL =
  'font-mono text-3xs uppercase tracking-[0.08em] text-muted-foreground/70';

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
      <div className={MICRO_LABEL}>{label}</div>
      <div className="mt-0.5 font-mono text-[0.9375rem] leading-tight tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-0.5 truncate text-3xs text-muted-foreground/70">{hint}</div>
    </div>
  );
}

function Pill({
  children,
  tone = 'plain',
  className,
}: {
  children: React.ReactNode;
  tone?: 'plain' | 'accent' | 'warn' | 'muted';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px font-mono text-3xs whitespace-nowrap',
        tone === 'accent' && 'border-primary/25 bg-primary/10 text-primary',
        tone === 'warn' && 'border-warning/30 bg-warning/10 text-warning-fg',
        tone === 'muted' && 'border-transparent text-muted-foreground/70',
        tone === 'plain' && 'border-border/70 text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The mockup's row switch, built on the Button primitive so it carries the
 *  focus ring and the `role="switch"` semantics the row's toggle needs. */
function RowSwitch({
  checked,
  onChange,
  label,
  busy,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  busy?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        'relative h-4 w-7 rounded-full border transition-colors',
        checked ? 'border-primary/40 bg-primary/20' : 'border-border bg-muted',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] left-[2px] size-2.5 rounded-full bg-muted-foreground transition-transform',
          checked && 'translate-x-3 bg-primary',
        )}
      />
    </Button>
  );
}

function CheckCell({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-pressed={checked}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        'size-4 rounded border p-0',
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-muted/40',
      )}
    >
      {checked ? <MoreHorizontal className="size-3 opacity-0" aria-hidden /> : null}
      <svg viewBox="0 0 24 24" className="size-3" aria-hidden>
        <path
          d="M5 12l4.5 4.5L19 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={checked ? 1 : 0}
        />
      </svg>
    </Button>
  );
}

function Kebab({ items }: { items: Array<{ label: string; onSelect: () => void; danger?: boolean }> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Row actions"
          onClick={(e) => e.stopPropagation()}
          className="size-6 text-muted-foreground"
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            onSelect={(e) => {
              e.preventDefault();
              item.onSelect();
            }}
            className={item.danger ? 'text-danger-fg' : undefined}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn(
        'h-7 rounded-md px-2.5 text-2xs',
        active
          ? 'border border-border/70 bg-muted text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </Button>
  );
}

function PanelHead({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    /* Wraps on purpose: four head actions cannot share a row with the blurb
       once the settings rail has taken its 240px, and a non-wrapping flex
       pushed "All tools" off the card edge instead. */
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-4">
      <div className="min-w-[12rem] flex-1 basis-[16rem]">
        <h3 className="text-[1.0625rem] leading-tight font-semibold tracking-tight text-foreground">
          {title}
        </h3>
        <p className="mt-1 max-w-[56ch] text-2xs leading-relaxed text-muted-foreground">{blurb}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function GroupHead({ label, count }: { label: string; count: string }) {
  return (
    <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-border/50 bg-muted/60 px-4 py-1.5 backdrop-blur">
      <div className="min-w-0 truncate text-2xs font-medium text-foreground/80">{label}</div>
      <div className="ml-auto shrink-0 font-mono text-3xs text-muted-foreground/70">{count}</div>
    </div>
  );
}

/** `1–12 of 1,284`, the way the mockup's footer states it. Both numbers are
 *  server facts: the total is the store's own COUNT, and the window is what
 *  this page is holding. */
function RangeFooter({
  from,
  to,
  total,
  page,
  pages,
  onPrev,
  onNext,
  onPage,
}: {
  from: number;
  to: number;
  total: number;
  page: number;
  pages: number;
  onPrev: () => void;
  onNext: () => void;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-border/50 px-4 py-2">
      <div className="font-mono text-3xs tabular-nums text-muted-foreground/80">
        {total === 0 ? 'none' : `${from}–${to} of ${total.toLocaleString('en-US')}`}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page === 0} onClick={onPrev}>
          ‹
        </Button>
        {Array.from({ length: Math.min(pages, 6) }, (_, i) => i).map((i) => (
          <Button
            key={i}
            variant={i === page ? 'secondary' : 'outline'}
            size="icon-sm"
            className="font-mono text-3xs"
            aria-current={i === page ? 'page' : undefined}
            onClick={() => onPage(i)}
          >
            {i + 1}
          </Button>
        ))}
        <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page >= pages - 1} onClick={onNext}>
          ›
        </Button>
      </div>
    </div>
  );
}

function EmptyRows({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-5 py-9 text-center">
      <div className="text-[0.8125rem] font-medium text-foreground/90">{title}</div>
      <div className="mx-auto mt-1 max-w-[42ch] text-2xs leading-relaxed text-muted-foreground">{hint}</div>
    </div>
  );
}

function ConfirmState(props: {
  state: ReturnType<typeof useConfirmDialog>['state'];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const s = props.state;
  return (
    <ConfirmDialog
      open={s.open}
      title={s.title}
      message={s.message}
      confirmLabel={s.confirmLabel}
      cancelLabel={s.cancelLabel}
      variant={s.variant}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}

/* ── memory ────────────────────────────────────────────────────────── */

const MEM_STORES = ['facts', 'memory', 'heuristics'];
/** The server caps one browse page at 200 rows; the library walks that window
 *  in 12-row pages (the mockup's page size) and steps the window when it runs
 *  out, so a store of thousands stays pageable rather than truncated. */
const FETCH_WINDOW = 200;
const PAGE_SIZE = 12;

interface MemRow {
  key: string;
  store: string;
  id: string;
  title: string;
  /** The machine handle the model quotes (facts) or the file the note lives
   *  in (project markdown). Shown small, never as the row label. */
  handle: string;
  body: string;
  details: string;
  type: 'Fact' | 'Rule' | 'Note';
  scopeValue: string;
  scopeLabel: string;
  source: string;
  category: string;
  confidence: string;
  uses: number;
  lastUsed: string;
  updated: string;
  created: string;
  retired: boolean;
  /** `facts.kind === 'profile'` — the lane the model reads every turn. Kept as
   *  a boolean so the row badge and the detail pane ask one parsed question. */
  profileKind: boolean;
  supersededBy: string;
  contradicts: string;
  replaces: string[];
  /** 059: the value this row's latest edit replaced — "now X, previously Y".
   *  Empty on rows that were never edited or whose edit changed nothing. */
  previousValue: string;
  editable: boolean;
  deletable: boolean;
}

interface StorePage {
  rows?: Row[];
  total?: number;
  error?: string;
}

interface StoreInfo {
  name: string;
  label: string;
  count: number;
}

interface WorkspaceInfo {
  path: string;
  name: string;
  hasMemory?: boolean;
  hasSkills?: boolean;
  sessions?: number;
}

interface ProjectEntry {
  key: string;
  title: string;
  body: string;
  updated: string;
  file: string;
}

interface ProjectList {
  ok?: boolean;
  files?: ProjectFile[];
  entries?: ProjectEntry[];
}

interface ProjectFile {
  file: string;
  entries: number;
  updated?: string;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function toMemRow(store: string, row: Row, scopeLabelFor: (scope: string) => string): MemRow {
  const facts = store === 'facts';
  const kv = store === 'memory';
  const parsed = facts ? parseFactValue(row.factValue) : { summary: '', details: undefined };
  const kvNote = kv ? summarizeKvValue(row.value) : { summary: '', details: '' };
  const title = facts
    ? str(row.title).trim() || parsed.summary || str(row.factKey)
    : kv
      ? kvNote.summary || str(row.key)
      : str(row.rule) || '(untitled)';
  const scope = facts ? str(row.scope).trim() || 'global' : 'global';
  return {
    key: `${store}:${facts ? str(row.id) : kv ? str(row.key) : str(row.id)}`,
    store,
    id: facts ? str(row.id) : kv ? str(row.key) : str(row.id),
    title,
    handle: facts ? str(row.factKey) : kv ? str(row.key) : `rule ${str(row.id)}`,
    body: facts ? parsed.summary : kv ? kvNote.details : str(row.rule),
    details: facts ? parsed.details ?? '' : kv ? kvNote.details : '',
    // The three vocabularies the library's Type column has. `heuristics` is the
    // legacy learned-rules table, `memory` is the KV note store, facts are
    // facts — and a `kind: profile` fact is still a fact, just one the model
    // sees every turn (the detail pane says so).
    type: store === 'heuristics' ? 'Rule' : kv ? 'Note' : 'Fact',
    scopeValue: scope,
    scopeLabel: scopeLabelFor(scope),
    source: facts ? str(row.source) : str(row.source),
    category: str(row.category),
    confidence: row.confidence === undefined || row.confidence === null ? '' : str(row.confidence),
    uses: Number(row.useCount ?? 0) || 0,
    lastUsed: str(row.lastUsedAt),
    updated: str(row.updatedAt),
    created: str(row.createdAt),
    retired: str(row.status).trim() === 'retired',
    profileKind: facts && str(row.kind).trim().toLowerCase() === 'profile',
    supersededBy: str(row.supersededBy),
    previousValue: str(row.previousValue ?? ''),
    contradicts: str(row.contradicts),
    replaces: (() => {
      const raw = row.supersedes;
      if (Array.isArray(raw)) return raw.map((x) => str(x)).filter(Boolean);
      const s = str(raw).trim();
      if (!s) return [];
      try {
        const p: unknown = JSON.parse(s);
        return Array.isArray(p) ? p.map((x) => str(x)).filter(Boolean) : [];
      } catch {
        return [];
      }
    })(),
    editable: facts || kv,
    deletable: true,
  };
}

/** A profile-lane fact is the one memory the model reads every turn; the row
 *  says which lane it is in rather than inventing a fourth Type value. */

function projectRow(entry: ProjectEntry, workspaceName: string): MemRow {
  return {
    key: `project:${workspaceName}:${entry.file}#${entry.key}`,
    store: 'project',
    id: entry.key,
    title: entry.title || entry.key,
    handle: entry.file,
    body: entry.body,
    details: '',
    type: 'Note',
    scopeValue: `project:${workspaceName}`,
    scopeLabel: workspaceName,
    source: 'project',
    category: 'project',
    confidence: '',
    uses: 0,
    lastUsed: '',
    updated: entry.updated,
    created: entry.updated,
    retired: false,
    profileKind: false,
    supersededBy: '',
    previousValue: '',
    contradicts: '',
    replaces: [],
    editable: true,
    deletable: true,
  };
}

function memoryMarkdown(r: MemRow): string {
  return [
    '---',
    `name: ${r.title}`,
    `description: ${r.body.split('\n')[0].slice(0, 120)}`,
    `type: ${r.category || r.store}`,
    r.updated ? `updated: ${r.updated}` : '',
    '---',
    '',
    r.body,
    r.details && r.details !== r.body ? r.details : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function MemoryLibrary({
  counts,
  totalCount,
  projectWorkspaces,
}: {
  counts: (store: string) => number;
  totalCount: number;
  projectWorkspaces: WorkspaceInfo[];
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { state: confirmState, confirm, handleConfirm, handleCancel } = useConfirmDialog();
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'all' | 'Fact' | 'Rule' | 'Note'>('all');
  const [scope, setScope] = useState('all');
  const [sort, setSort] = useState('updated');
  const [page, setPage] = useState(0);
  const [window_, setWindow] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const query = search.trim();
  const projectScope = scope.startsWith('project:');
  const projectPath = projectScope ? scope.slice('project:'.length) : '';
  const primaryProject = projectWorkspaces[0]?.path ?? '';
  const primaryProjectName = projectWorkspaces[0]?.name ?? '';
  /** Which workspace's markdown memory to fold into the list: the one the
   *  scope picker named, else the first known project with memory. */
  const listedProject = projectPath || primaryProject;

  const scopeLabelFor = useMemo(
    () => (scope: string): string => {
      if (!scope || scope === 'global') return 'Global';
      if (scope.startsWith('bot:')) return `Bot · ${scope.slice(4)}`;
      return scope;
    },
    [],
  );

  const fetchFor = (store: string) =>
    api.get<StorePage>(
      `/api/brain/stores/${encodeURIComponent(store)}` +
        `?limit=${FETCH_WINDOW}&offset=${window_ * FETCH_WINDOW}` +
        `&query=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}` +
        // The facts table is the only browsable store with a scope column, so
        // a scope filter is sent to it and never to the KV/legacy stores —
        // those rows ARE global by storage, which is what "Global" asks for.
        (store === 'facts' && (scope === 'global' || scope.startsWith('bot:'))
          ? `&scope=${encodeURIComponent(scope)}`
          : ''),
    );

  const enabled = (store: string) =>
    !projectScope && (scope === 'all' || scope === 'global' || store === 'facts');

  const factsQ = useQuery({
    queryKey: ['lib-store', 'facts', window_, query, sort, scope],
    queryFn: () => fetchFor('facts'),
    enabled: enabled('facts'),
  });
  const notesQ = useQuery({
    queryKey: ['lib-store', 'memory', window_, query, sort, scope],
    queryFn: () => fetchFor('memory'),
    enabled: enabled('memory'),
  });
  const rulesQ = useQuery({
    queryKey: ['lib-store', 'heuristics', window_, query, sort, scope],
    queryFn: () => fetchFor('heuristics'),
    enabled: enabled('heuristics'),
  });
  /** The retired count, asked of the store rather than counted off the page:
   *  a number on a stat card is a claim about the whole library. */
  const retiredQ = useQuery({
    queryKey: ['lib-retired-count'],
    queryFn: () => api.get<StorePage>('/api/brain/stores/facts?limit=1&status=retired'),
  });
  /** The same question for the global lane, and asked of the store rather than
   *  of the page. It counts ACTIVE rows so the card reconciles with "Active":
   *  a parked fact is in neither lane's working set, and a Global number that
   *  included it could read larger than Active. */
  const globalQ = useQuery({
    queryKey: ['lib-global-count'],
    queryFn: () => api.get<StorePage>('/api/brain/stores/facts?limit=1&scope=global&status=active'),
  });
  const projectQ = useQuery<ProjectList>({
    queryKey: ['lib-project-memory', listedProject],
    queryFn: () =>
      api.post<ProjectList>('/api/august/memory/manage', {
        action: 'list',
        scope: 'project',
        workspace: listedProject,
      }),
    enabled: listedProject !== '',
  });
  /** Bot names, so a `bot:<id>` scope reads as the assistant it belongs to. */
  const agentsQ = useQuery({
    queryKey: ['lib-agents'],
    queryFn: () => api.get<{ agents: Array<{ id: string; name?: string }> }>('/api/agents'),
    retry: false,
  });

  const rows = useMemo<MemRow[]>(() => {
    const agentName = new Map(
      (agentsQ.data?.agents ?? []).map((a) => [a.id, a.name || a.id] as const),
    );
    const label = (scopeValue: string): string => {
      if (scopeValue.startsWith('bot:')) {
        const id = scopeValue.slice(4);
        return `Bot · ${agentName.get(id) ?? id}`;
      }
      return scopeLabelFor(scopeValue);
    };
    const out: MemRow[] = [];
    for (const [store, q] of [
      ['facts', factsQ],
      ['memory', notesQ],
      ['heuristics', rulesQ],
    ] as const) {
      for (const row of q.data?.rows ?? []) {
        out.push(toMemRow(store, row, label));
      }
    }
    // The project layer is one workspace's markdown entries: whichever the
    // scope picker named, else the first project that has memory at all.
    const projectName =
      projectWorkspaces.find((w) => w.path === listedProject)?.name ?? primaryProjectName;
    for (const e of projectQ.data?.entries ?? []) {
      out.push(projectRow(e, projectName));
    }
    return out;
  }, [
    factsQ.data,
    notesQ.data,
    rulesQ.data,
    projectQ.data,
    agentsQ.data,
    scope,
    projectScope,
    scopeLabelFor,
    listedProject,
    primaryProjectName,
    projectWorkspaces,
  ]);

  /* Type is a column the stores do not share, so it filters the merged list;
   * search and scope are asked server-side so they hold past the window. */
  const visible = useMemo(() => {
    const filtered = type === 'all' ? rows : rows.filter((r) => r.type === type);
    return [...filtered].sort((a, b) => {
      if (sort === 'confidence') return Number(b.confidence || 0) - Number(a.confidence || 0);
      if (sort === 'newest') return stampTime(b.created) - stampTime(a.created);
      if (sort === 'oldest') return stampTime(a.created) - stampTime(b.created);
      return stampTime(b.updated) - stampTime(a.updated);
    });
  }, [rows, type, sort]);

  const pageRows = visible.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const loading = factsQ.isPending || notesQ.isPending || rulesQ.isPending;

  const retiredCount = retiredQ.data?.total ?? 0;
  const activeTotal = Math.max(0, totalCount - retiredCount);
  const globalTotal = (globalQ.data?.total ?? 0) + counts('memory') + counts('heuristics');
  const projectTotal = (projectQ.data?.entries ?? []).length;

  const active = rows.find((r) => r.key === activeKey) ?? null;
  useEffect(() => {
    if (activeKey === null && rows.length > 0) setActiveKey(rows[0].key);
  }, [activeKey, rows]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['lib-store'] });
    void qc.invalidateQueries({ queryKey: ['brain-stores'] });
    void qc.invalidateQueries({ queryKey: ['lib-retired-count'] });
    void qc.invalidateQueries({ queryKey: ['lib-global-count'] });
    void qc.invalidateQueries({ queryKey: ['lib-project-memory'] });
  };

  const patchMut = useMutation({
    mutationFn: (p: { store: string; id: string; patch: Record<string, unknown> }) =>
      api.patch(`/api/brain/stores/${encodeURIComponent(p.store)}/${encodeURIComponent(p.id)}`, p.patch),
    onSuccess: () => {
      invalidate();
      setEditing(false);
      toast.success('Memory updated');
    },
    onError: (e: Error) => toast.error(e.message || 'Update failed'),
  });
  const deleteMut = useMutation({
    mutationFn: async (r: MemRow) => {
      if (r.store === 'project') {
        await api.post('/api/august/memory/manage', {
          action: 'delete',
          scope: 'project',
          workspace: listedProject,
          key: r.id,
        });
      } else {
        await api.delete(`/api/brain/stores/${encodeURIComponent(r.store)}/${encodeURIComponent(r.id)}`);
      }
    },
    onSuccess: () => {
      invalidate();
      setActiveKey(null);
      toast.success('Entry deleted');
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });
  const addMut = useMutation({
    mutationFn: (p: { text: string; category: string; target: 'fact' | 'note' | 'project' }) => {
      const first = p.text.split('\n')[0].slice(0, 80);
      if (p.target === 'project') {
        return api.post('/api/august/memory/manage', {
          action: 'set',
          scope: 'project',
          workspace: listedProject,
          key: first,
          value: p.text,
          details: '',
        });
      }
      const slug = first
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
      if (p.target === 'note') {
        // `store:'memory'` is the KV note lane; without it the same door writes
        // a fact row.
        return api.post('/api/august/memory/manage', {
          action: 'set',
          store: 'memory',
          key: `${slug || 'note'}`,
          value: p.text,
        });
      }
      return api.post('/api/august/memory/manage', {
        action: 'set',
        key: `note:${slug || 'note'}`,
        value: p.text,
        category: p.category,
        source: 'user',
      });
    },
    onSuccess: () => {
      invalidate();
      setAddOpen(false);
      toast.success('Memory saved');
    },
    onError: (e: Error) => toast.error(e.message || 'Could not save'),
  });

  const askDelete = (r: MemRow) => {
    void confirm({
      title: 'Delete this entry?',
      message: `“${r.title}” will be removed. This cannot be undone from here.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    }).then((ok) => {
      if (ok) deleteMut.mutate(r);
    });
  };

  const bulkDelete = () => {
    const targets = rows.filter((r) => checked.has(r.key));
    if (targets.length === 0) return;
    void confirm({
      title: `Delete ${targets.length} entries?`,
      message: 'They are removed from the store. This cannot be undone from here.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    }).then((ok) => {
      if (!ok) return;
      void Promise.all(
        targets.map((r) =>
          r.store === 'project'
            ? api.post('/api/august/memory/manage', {
                action: 'delete',
                scope: 'project',
                workspace: listedProject,
                key: r.id,
              })
            : api.delete(`/api/brain/stores/${encodeURIComponent(r.store)}/${encodeURIComponent(r.id)}`),
        ),
      ).then(() => {
        invalidate();
        setChecked(new Set());
        toast.success(`${targets.length} deleted`);
      });
    });
  };

  const scopeOptions = [
    { value: 'all', label: 'All scopes' },
    { value: 'global', label: 'Global' },
    ...projectWorkspaces.map((w) => ({ value: `project:${w.path}`, label: `Project · ${w.name}` })),
  ];

  const groups = new Map<string, MemRow[]>();
  for (const r of pageRows) {
    const list = groups.get(r.scopeLabel) ?? [];
    list.push(r);
    groups.set(r.scopeLabel, list);
  }

  return (
    <section className="grid min-w-0 items-start gap-3 min-[1500px]:grid-cols-[minmax(0,1fr)_352px]">
      <div
        data-testid="library-list"
        className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card"
      >
        <PanelHead
          title="Memory"
          blurb="Durable facts, rules and notes. Search first; the list is paged."
        >
          <Button variant="outline" size="sm" onClick={() => setToolsOpen((v) => !v)}>
            <SlidersHorizontal /> {toolsOpen ? 'Hide tools' : 'Switches'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Download /> Import
          </Button>
          <Button size="sm" onClick={() => setAddOpen((v) => !v)}>
            <Plus /> Add memory
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void navigate('/settings/memory-tools')}>
            <Wrench /> All tools
          </Button>
        </PanelHead>

        {toolsOpen ? (
          <div className="mx-4 mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="text-2xs font-medium text-foreground">How memory behaves</div>
            <p className="mt-1 text-3xs leading-relaxed text-muted-foreground">
              The switches, the store budget, the consolidation pass and the backups all live on
              the memory tools door — one place, so a setting is never edited from two surfaces.
            </p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void navigate('/settings/memory-tools')}>
              Open memory tools
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-1.5 px-4 pt-3 min-[1240px]:grid-cols-4">
          <Stat label="Active" value={activeTotal.toLocaleString('en-US')} hint="live entries" />
          <Stat label="Global" value={globalTotal.toLocaleString('en-US')} hint="every project" />
          <Stat
            label="Project"
            value={projectTotal.toLocaleString('en-US')}
            hint={primaryProjectName || 'no project memory'}
          />
          <Stat label="Retired" value={retiredCount.toLocaleString('en-US')} hint="restorable" />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3 pb-2">
          <div className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 text-muted-foreground">
            <Search className="size-3.5 shrink-0" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
                setWindow(0);
              }}
              placeholder="Search facts, keys, or scope…"
              aria-label="Search memory"
              className="min-w-0 flex-1 bg-transparent text-2xs text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          {(['all', 'Fact', 'Rule', 'Note'] as const).map((t) => (
            <FilterChip
              key={t}
              active={type === t}
              onClick={() => {
                setType(t);
                setPage(0);
              }}
            >
              {t === 'all' ? 'All' : t === 'Fact' ? 'Facts' : t === 'Rule' ? 'Rules' : 'Notes'}
            </FilterChip>
          ))}
          <SettingsSelect
            aria-label="Scope"
            size="sm"
            value={scope}
            onChange={(v) => {
              setScope(v);
              setPage(0);
              setWindow(0);
            }}
            options={scopeOptions}
          />
          <SettingsSelect
            aria-label="Sort"
            size="sm"
            value={sort}
            onChange={(v) => {
              setSort(v);
              setPage(0);
            }}
            options={[
              { value: 'updated', label: 'Recently updated' },
              { value: 'newest', label: 'Newest' },
              { value: 'oldest', label: 'Oldest' },
              { value: 'confidence', label: 'Confidence' },
            ]}
          />
        </div>

        {checked.size > 0 ? (
          <div className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-2xs text-muted-foreground">
            <span className="font-medium text-foreground">{checked.size} selected</span>
            <span className="ml-auto flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="sm" className="h-6 px-2 text-2xs" onClick={() => setChecked(new Set())}>
                Clear
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-2xs"
                onClick={() => {
                  const picked = rows.filter((r) => checked.has(r.key));
                  downloadText(
                    `memory-${picked.length}-entries.md`,
                    picked.map(memoryMarkdown).join('\n\n---\n\n'),
                    'text/markdown;charset=utf-8',
                  );
                }}
              >
                Export
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-2xs text-danger-fg" onClick={bulkDelete}>
                Delete
              </Button>
            </span>
          </div>
        ) : null}

        <div className={cn(MEM_COLS, 'items-center gap-2 border-y border-border/50 px-4 py-1.5', MICRO_LABEL)}>
          <CheckCell
            checked={pageRows.length > 0 && pageRows.every((r) => checked.has(r.key))}
            label="Select all rows on this page"
            onToggle={() => {
              const all = pageRows.every((r) => checked.has(r.key));
              const next = new Set(checked);
              for (const r of pageRows) {
                if (all) next.delete(r.key);
                else next.add(r.key);
              }
              setChecked(next);
            }}
          />
          <div>Memory</div>
          <div className={CELL}>Type</div>
          <div className={CELL}>Last used</div>
          <div />
        </div>

        {loading && rows.length === 0 ? (
          <div className="px-4 py-6 text-2xs text-muted-foreground" data-testid="library-memory-loading">
            Loading entries…
          </div>
        ) : pageRows.length === 0 ? (
          <EmptyRows
            title="Nothing matches."
            hint="Clear the search or the scope filter to see the rest of the library."
          />
        ) : (
          Array.from(groups.entries()).map(([label, list]) => (
            <div key={label}>
              {/* The count is of THIS page — a group head sits over a paged
                  slice, so it never claims the scope's whole total. */}
              <GroupHead label={label} count={`${list.length} on this page`} />
              {list.map((r) => (
                <div
                  key={r.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setActiveKey(r.key);
                    setEditing(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActiveKey(r.key);
                      setEditing(false);
                    }
                  }}
                  className={cn(
                    MEM_COLS,
                    'items-center gap-2 border-b border-border/40 px-4 py-2 text-left transition-colors hover:bg-muted/40',
                    r.key === activeKey && 'bg-primary/5',
                    r.retired && 'opacity-70',
                  )}
                >
                  <CheckCell
                    checked={checked.has(r.key)}
                    label={`Select ${r.title}`}
                    onToggle={() => {
                      const next = new Set(checked);
                      if (next.has(r.key)) next.delete(r.key);
                      else next.add(r.key);
                      setChecked(next);
                    }}
                  />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <div className="min-w-0 truncate text-2xs font-medium text-foreground">{r.title}</div>
                      {r.profileKind ? <Pill tone="accent">profile</Pill> : null}
                      {r.retired ? <Pill tone="muted">retired</Pill> : null}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-3xs text-muted-foreground/70">
                      <div className="min-w-0 truncate">{r.handle}</div>
                      <div className="shrink-0">·</div>
                      <div className="min-w-0 truncate">{r.source || r.store}</div>
                      {r.uses > 0 ? (
                        <>
                          <div className="shrink-0">·</div>
                          <div className="shrink-0 tabular-nums">{r.uses} uses</div>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className={CELL}>
                    <Pill tone={r.type === 'Rule' ? 'warn' : r.type === 'Fact' ? 'accent' : 'muted'}>
                      {r.type}
                    </Pill>
                  </div>
                  <div className={cn(CELL, 'font-mono text-3xs text-muted-foreground/80')}>
                    {r.lastUsed ? `${timeAgo(r.lastUsed)} ago` : r.updated ? shortUpdated(r.updated) : '—'}
                  </div>
                  <div className="flex justify-end">
                    <Kebab
                      items={[
                        { label: 'Open detail', onSelect: () => setActiveKey(r.key) },
                        { label: 'Copy key', onSelect: () => void navigator.clipboard?.writeText(r.handle) },
                        {
                          label: 'Export as markdown',
                          onSelect: () => downloadText(`${r.handle.slice(0, 40) || 'memory'}.md`, memoryMarkdown(r), 'text/markdown;charset=utf-8'),
                        },
                        ...(r.retired
                          ? [
                              {
                                label: 'Restore',
                                onSelect: () =>
                                  void patchMut.mutate({ store: 'facts', id: r.id, patch: { status: 'active' } }),
                              },
                            ]
                          : []),
                        { label: 'Delete', onSelect: () => askDelete(r), danger: true },
                      ]}
                    />
                  </div>
                </div>
              ))}
            </div>
          ))
        )}

        <RangeFooter
          from={visible.length === 0 ? 0 : page * PAGE_SIZE + 1}
          to={Math.min(visible.length, (page + 1) * PAGE_SIZE)}
          total={visible.length}
          page={page}
          pages={totalPages}
          onPrev={() => {
            if (page > 0) setPage(page - 1);
            else if (window_ > 0) {
              setWindow(window_ - 1);
              setPage(Math.max(0, Math.ceil((window_ * FETCH_WINDOW) / PAGE_SIZE) - 1));
            }
          }}
          onNext={() => {
            if (page + 1 < totalPages) setPage(page + 1);
            else {
              setWindow(window_ + 1);
              setPage(0);
            }
          }}
          onPage={setPage}
        />
      </div>

      <aside
        data-testid="library-detail"
        className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card min-[1500px]:sticky min-[1500px]:top-3"
      >
        {active ? (
          <MemoryDetail
            row={active}
            editing={editing}
            draft={draft}
            saving={patchMut.isPending}
            onEdit={() => {
              setDraft({
                [FACTS_VALUE_FIELD]: active.body,
                [FACTS_DETAILS_FIELD]: active.details,
                category: active.category,
                confidence: active.confidence,
                value: active.store === 'memory' ? active.body : '',
              });
              setEditing(true);
            }}
            onDraft={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
            onCancel={() => setEditing(false)}
            onSave={() => {
              if (active.store === 'facts') {
                patchMut.mutate({
                  store: 'facts',
                  id: active.id,
                  patch: {
                    [FACTS_VALUE_FIELD]: composeFactValue(
                      draft[FACTS_VALUE_FIELD] ?? '',
                      draft[FACTS_DETAILS_FIELD] ?? '',
                    ),
                    ...(draft.category !== '' ? { category: draft.category } : {}),
                    ...(draft.confidence !== '' ? { confidence: Number(draft.confidence) } : {}),
                  },
                });
              } else if (active.store === 'memory') {
                patchMut.mutate({ store: 'memory', id: active.id, patch: { value: draft.value ?? '' } });
              } else if (active.store === 'project') {
                addMut.mutate({ text: draft.value ?? active.body, category: 'project', target: 'project' });
              }
            }}
            onDelete={() => askDelete(active)}
            onRestore={() =>
              patchMut.mutate({ store: 'facts', id: active.id, patch: { status: 'active' } })
            }
          />
        ) : (
          <div className="p-4">
            <div className="text-2xs font-semibold">Detail</div>
            <p className="mt-1 text-3xs leading-relaxed text-muted-foreground">
              Pick a row to see what it says, where it came from, and what August does with it.
            </p>
          </div>
        )}
      </aside>

      <AddMemoryForm
        open={addOpen}
        busy={addMut.isPending}
        hasProject={listedProject !== ''}
        onClose={() => setAddOpen(false)}
        onSubmit={(text, category, target) => addMut.mutate({ text, category, target })}
      />
      <ImportMemoryDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={invalidate} />
      <ConfirmState state={confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
    </section>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-border/50 pt-1.5">
      <div className={MICRO_LABEL}>{label}</div>
      <div className="mt-0.5 text-2xs text-foreground/80">{value || '—'}</div>
    </div>
  );
}

function DetailSectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex items-center gap-2 font-mono text-3xs uppercase tracking-[0.12em] text-muted-foreground/70">
      {children}
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}

function MemoryDetail({
  row,
  editing,
  draft,
  saving,
  onEdit,
  onDraft,
  onCancel,
  onSave,
  onDelete,
  onRestore,
}: {
  row: MemRow;
  editing: boolean;
  draft: Record<string, string>;
  saving: boolean;
  onEdit: () => void;
  onDraft: (k: string, v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const injects = !row.retired;
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
        <div className="min-w-0 truncate text-2xs font-semibold text-foreground">Memory detail</div>
        <div className={cn('ml-auto shrink-0', MICRO_LABEL)}>{row.type}</div>
      </div>
      <div className="px-3.5 py-3.5">
        <div className="truncate font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground/70">
          {row.scopeLabel} / {row.handle}
        </div>
        <h3 className="mt-1.5 font-editorial text-[1.4rem] leading-[1.15] font-medium tracking-[-0.02em] text-foreground">
          {row.title}
        </h3>
        <div className="mt-2.5 flex flex-wrap gap-1">
          <Pill tone={row.type === 'Rule' ? 'warn' : row.type === 'Fact' ? 'accent' : 'muted'}>{row.type}</Pill>
          <Pill>{row.scopeLabel}</Pill>
          {row.source ? <Pill tone="muted">{row.source}</Pill> : null}
          {row.retired ? <Pill tone="muted">retired</Pill> : null}
        </div>
        {editing ? (
          <div className="mt-3 space-y-2">
            <textarea
              value={
                row.store === 'memory'
                  ? (draft.value ?? '')
                  : (draft[FACTS_VALUE_FIELD] ?? draft.value ?? '')
              }
              onChange={(e) =>
                onDraft(row.store === 'memory' ? 'value' : FACTS_VALUE_FIELD, e.target.value)
              }
              rows={4}
              aria-label="Memory text"
              className="w-full rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-2xs text-foreground outline-none focus:border-primary/40"
            />
            {row.store === 'facts' ? (
              <textarea
                value={draft[FACTS_DETAILS_FIELD] ?? ''}
                onChange={(e) => onDraft(FACTS_DETAILS_FIELD, e.target.value)}
                rows={3}
                placeholder="Details (optional)"
                aria-label="Details"
                className="w-full rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-2xs text-foreground outline-none focus:border-primary/40"
              />
            ) : null}
            {row.store !== 'project' ? (
              <div className="flex gap-2">
                <input
                  value={draft.category ?? ''}
                  onChange={(e) => onDraft('category', e.target.value)}
                  placeholder="Category"
                  aria-label="Category"
                  className="min-w-0 flex-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-2xs outline-none focus:border-primary/40"
                />
                {row.store === 'facts' ? (
                  <input
                    value={draft.confidence ?? ''}
                    onChange={(e) => onDraft('confidence', e.target.value)}
                    placeholder="Confidence"
                    aria-label="Confidence"
                    inputMode="decimal"
                    className="w-24 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-2xs outline-none focus:border-primary/40"
                  />
                ) : null}
              </div>
            ) : null}
            <div className="flex gap-1.5">
              <Button size="sm" disabled={saving} onClick={onSave}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-2.5 text-2xs leading-relaxed whitespace-pre-wrap text-foreground/85">
            {row.body || '(no text stored)'}
          </p>
        )}
        {row.details && row.details !== row.body && !editing ? (
          <div className="mt-2 rounded-md border border-border/60 bg-muted/30 p-2 font-mono text-3xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {row.details}
          </div>
        ) : null}

        <p className="mt-2.5 text-3xs leading-relaxed text-muted-foreground">
          {row.store === 'project'
            ? 'This is a project memory file entry: it reaches the model through the workspace memory layer, not the facts table.'
            : injects
              ? 'Recalled when a memory tool runs, and in the relevant-memory tail while auto-injection is on.'
              : 'Retired: recall skips it, and nothing is deleted. Restore it from here.'}
        </p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {row.store === 'facts' ? <DetailCell label="Confidence" value={row.confidence} /> : null}
          <DetailCell label="Uses" value={row.uses ? `${row.uses} times` : row.store === 'project' ? 'not counted' : '0 times'} />
          <DetailCell label="Created" value={absoluteDay(row.created)} />
          <DetailCell label="Last used" value={row.lastUsed ? timeAgo(row.lastUsed) : shortUpdated(row.updated) || 'never'} />
          {row.previousValue ? (
            <DetailCell label="Previously" value={row.previousValue} />
          ) : null}
        </div>

        {row.supersededBy || row.contradicts || row.replaces.length > 0 ? (
          <>
            <DetailSectionTitle>Lineage</DetailSectionTitle>
            <div className="mt-1.5">
              {row.supersededBy ? (
                <div className="flex items-center gap-2 border-b border-border/40 py-1.5 text-2xs text-muted-foreground last:border-0">
                  <div className="min-w-0 truncate font-medium text-foreground/85">{row.supersededBy}</div>
                  <div className="ml-auto shrink-0 font-mono text-3xs">superseded by</div>
                </div>
              ) : null}
              {row.contradicts ? (
                <div className="flex items-center gap-2 border-b border-border/40 py-1.5 text-2xs text-muted-foreground last:border-0">
                  <div className="min-w-0 truncate font-medium text-foreground/85">{row.contradicts}</div>
                  <div className="ml-auto shrink-0 font-mono text-3xs">conflicts with</div>
                </div>
              ) : null}
              {row.replaces.map((k) => (
                <div key={k} className="flex items-center gap-2 border-b border-border/40 py-1.5 text-2xs text-muted-foreground last:border-0">
                  <div className="min-w-0 truncate font-medium text-foreground/85">{k}</div>
                  <div className="ml-auto shrink-0 font-mono text-3xs">replaces</div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-1.5">
          {row.editable || row.store === 'project' ? (
            <Button size="sm" onClick={onEdit}>
              Edit
            </Button>
          ) : null}
          {/* A human may un-park a retired fact; parking one is the
              consolidation pass's decision, and the store refuses the other
              direction ("status may only be set to 'active'"). So this button
              renders in one state only. */}
          {row.store === 'facts' && row.retired ? (
            <Button size="sm" variant="outline" onClick={onRestore} disabled={saving}>
              Restore
            </Button>
          ) : null}
          <Button size="sm" variant="outline" className="text-danger-fg" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
    </>
  );
}

function AddMemoryForm({
  open,
  busy,
  hasProject,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  hasProject: boolean;
  onClose: () => void;
  onSubmit: (text: string, category: string, target: 'fact' | 'note' | 'project') => void;
}) {
  const [text, setText] = useState('');
  const [category, setCategory] = useState('general');
  const [target, setTarget] = useState<'fact' | 'note' | 'project'>('fact');
  if (!open) return null;
  return (
    <div className="mx-4 mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="text-2xs font-medium text-foreground">Add a memory</div>
        {/* The two stores a sentence can land in, plus the project layer when
            there is one. `store:'memory'` is the ONLY way the KV note store
            takes a write from this door, so the choice is the door's, not a
            guess made downstream. */}
        <div className="ml-auto flex items-center gap-1">
          {hasProject ? (
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-6 px-2 text-3xs', target === 'project' && 'bg-muted text-foreground')}
              onClick={() => setTarget('project')}
            >
              Project
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-6 px-2 text-3xs', target === 'fact' && 'bg-muted text-foreground')}
            onClick={() => setTarget('fact')}
          >
            Fact
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-6 px-2 text-3xs', target === 'note' && 'bg-muted text-foreground')}
            onClick={() => setTarget('note')}
          >
            Note
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-3xs" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        autoFocus
        placeholder="What should August remember?"
        aria-label="New memory"
        className="mt-2 w-full rounded-md border border-border/60 bg-card px-2 py-1.5 text-2xs text-foreground outline-none focus:border-primary/40"
      />
      <div className="mt-2 flex items-center gap-2">
        {target === 'fact' ? (
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Category"
            aria-label="Category"
            className="w-40 rounded-md border border-border/60 bg-card px-2 py-1.5 text-2xs outline-none focus:border-primary/40"
          />
        ) : (
          <p className="text-3xs leading-relaxed text-muted-foreground">
            {target === 'note'
              ? 'A note is the key-value store: the first line is what the list shows.'
              : 'Written into this project’s .aug/memory markdown, not the database.'}
          </p>
        )}
        <Button
          size="sm"
          className="ml-auto"
          disabled={busy || text.trim() === ''}
          onClick={() => {
            onSubmit(text.trim(), category, target);
            setText('');
          }}
        >
          {busy ? 'Saving…' : 'Save memory'}
        </Button>
      </div>
    </div>
  );
}

/* ── skills ────────────────────────────────────────────────────────── */

interface SkillRow {
  name: string;
  description: string;
  trigger: string;
  category: string;
  enabled: boolean;
  createdBy: string;
  scope: string;
  overrides: string;
  origin: string;
  status: string;
  version: number;
  usageCount: number;
  lastUsed: string;
  workspace?: string;
}

const SOURCE_LABEL: Record<string, string> = {
  bundled: 'Bundled',
  global: 'Installed',
  agent: 'Installed',
  project: 'Project',
  bot: 'Bot',
};

function skillSourceLabel(scope: string): string {
  if (scope === 'bundled') return SOURCE_LABEL.bundled;
  if (scope === 'project') return SOURCE_LABEL.project;
  if (scope === 'bot') return SOURCE_LABEL.bot;
  return SOURCE_LABEL.global;
}

function SkillsLibrary({ workspaces }: { workspaces: WorkspaceInfo[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { state: confirmState, confirm, handleConfirm, handleCancel } = useConfirmDialog();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [source, setSource] = useState('all');
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [activeName, setActiveName] = useState<string | null>(null);
  const [packsOpen, setPacksOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const projectWorkspace = workspaces[0]?.path ?? '';

  const skillsQ = useQuery<{ skills: SkillRow[]; total: number }>({
    queryKey: ['lib-skills', search, projectWorkspace],
    queryFn: () =>
      api.get<{ skills: SkillRow[]; total: number }>(
        `/api/skills?q=${encodeURIComponent(search.trim())}` +
          (projectWorkspace ? `&workspace=${encodeURIComponent(projectWorkspace)}` : ''),
      ),
  });

  const detailQ = useQuery<Record<string, unknown>>({
    queryKey: ['lib-skill', activeName, projectWorkspace],
    queryFn: () =>
      api.get<Record<string, unknown>>(
        `/api/skills/${encodeURIComponent(activeName ?? '')}` +
          (projectWorkspace ? `?workspace=${encodeURIComponent(projectWorkspace)}` : ''),
      ),
    enabled: activeName !== null,
  });

  const rows = useMemo(() => {
    const all = (skillsQ.data?.skills ?? []).map((s) => ({
      ...s,
      scope: s.scope || 'global',
    }));
    const filtered = all.filter((s) => {
      if (status === 'enabled' && !s.enabled) return false;
      if (status === 'disabled' && s.enabled) return false;
      if (source !== 'all' && skillSourceLabel(s.scope) !== source) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      return stampTime(b.lastUsed) - stampTime(a.lastUsed);
    });
  }, [skillsQ.data, status, source, sort]);

  const pageRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const active = rows.find((s) => s.name === activeName) ?? rows[0] ?? null;

  const patchMut = useMutation({
    mutationFn: (p: { name: string; disabled: boolean }) =>
      api.patch(`/api/skills/${encodeURIComponent(p.name)}`, {
        disabled: p.disabled,
        ...(projectWorkspace ? { workspace: projectWorkspace } : {}),
      }),
    onSuccess: (_r, p) => {
      void qc.invalidateQueries({ queryKey: ['lib-skills'] });
      toast.success(`${p.name} ${p.disabled ? 'disabled' : 'enabled'}`);
    },
    onError: (e: Error) => toast.error(e.message || 'Update failed'),
  });
  const deleteMut = useMutation({
    mutationFn: (name: string) =>
      api.delete(`/api/skills/${encodeURIComponent(name)}${projectWorkspace ? `?workspace=${encodeURIComponent(projectWorkspace)}` : ''}`),
    onSuccess: (_r, name) => {
      void qc.invalidateQueries({ queryKey: ['lib-skills'] });
      setActiveName(null);
      toast.success(`${name} moved to the skill trash`);
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });
  const createMut = useMutation({
    mutationFn: (p: { name: string; description: string; body: string }) =>
      api.post('/api/skills', { ...p, ...(projectWorkspace ? { workspace: projectWorkspace } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lib-skills'] });
      setCreateOpen(false);
      toast.success('Skill created');
    },
    onError: (e: Error) => toast.error(e.message || 'Could not create'),
  });

  const enabledCount = (skillsQ.data?.skills ?? []).filter((s) => s.enabled).length;
  const bundledCount = (skillsQ.data?.skills ?? []).filter((s) => s.scope === 'bundled').length;
  const freshest = [...(skillsQ.data?.skills ?? [])]
    .filter((s) => s.lastUsed)
    .sort((a, b) => stampTime(b.lastUsed) - stampTime(a.lastUsed))[0];

  const groups = new Map<string, SkillRow[]>();
  for (const s of pageRows) {
    const label = skillSourceLabel(s.scope);
    const list = groups.get(label) ?? [];
    list.push(s);
    groups.set(label, list);
  }

  return (
    <section className="grid min-w-0 items-start gap-3 min-[1500px]:grid-cols-[minmax(0,1fr)_352px]">
      <div
        data-testid="library-list"
        className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card"
      >
        <PanelHead
          title="Skills"
          blurb="Installed procedures and bundled capabilities. Disabling is reversible."
        >
          <Button variant="outline" size="sm" onClick={() => setPacksOpen((v) => !v)}>
            <Layers /> Skill packs
          </Button>
          <Button size="sm" onClick={() => setCreateOpen((v) => !v)}>
            <Plus /> New skill
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void navigate('/settings/skills-tools')}>
            <Wrench /> All tools
          </Button>
        </PanelHead>

        {packsOpen ? (
          <div className="mx-4 mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
            <SkillPacksPanel />
          </div>
        ) : null}
        {createOpen ? (
          <NewSkillForm
            busy={createMut.isPending}
            onClose={() => setCreateOpen(false)}
            onCreate={(name, description, body) => createMut.mutate({ name, description, body })}
          />
        ) : null}

        <div className="grid grid-cols-2 gap-1.5 px-4 pt-3 min-[1240px]:grid-cols-4">
          <Stat label="Installed" value={(skillsQ.data?.total ?? 0).toLocaleString('en-US')} hint={`${(skillsQ.data?.total ?? 0) - bundledCount} added`} />
          <Stat label="Enabled" value={enabledCount.toLocaleString('en-US')} hint={`${(skillsQ.data?.total ?? 0) - enabledCount} disabled`} />
          <Stat label="Bundled" value={bundledCount.toLocaleString('en-US')} hint="shipped with August" />
          <Stat
            label="Last used"
            value={freshest?.lastUsed ? timeAgo(freshest.lastUsed) : 'never'}
            hint={freshest?.name ?? 'never'}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3 pb-2">
          <div className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 text-muted-foreground">
            <Search className="size-3.5 shrink-0" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Search skills, tags, or authors…"
              aria-label="Search skills"
              className="min-w-0 flex-1 bg-transparent text-2xs text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          {(['all', 'enabled', 'disabled'] as const).map((s) => (
            <FilterChip
              key={s}
              active={status === s}
              onClick={() => {
                setStatus(s);
                setPage(0);
              }}
            >
              {s === 'all' ? 'All' : s === 'enabled' ? 'Enabled' : 'Disabled'}
            </FilterChip>
          ))}
          <SettingsSelect
            aria-label="Source"
            size="sm"
            value={source}
            onChange={(v) => {
              setSource(v);
              setPage(0);
            }}
            options={[
              { value: 'all', label: 'All sources' },
              { value: 'Bundled', label: 'Bundled' },
              { value: 'Installed', label: 'Installed' },
              { value: 'Project', label: 'Project' },
              { value: 'Bot', label: 'Bot' },
            ]}
          />
          <SettingsSelect
            aria-label="Sort"
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'recent', label: 'Recently used' },
              { value: 'name', label: 'Name' },
            ]}
          />
        </div>

        {checked.size > 0 ? (
          <div className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-2xs text-muted-foreground">
            <span className="font-medium text-foreground">{checked.size} selected</span>
            <span className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-6 px-2 text-2xs" onClick={() => setChecked(new Set())}>
                Clear
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-2xs"
                onClick={() => {
                  void Promise.all(
                    rows
                      .filter((s) => checked.has(s.name))
                      .map((s) =>
                        api.patch(`/api/skills/${encodeURIComponent(s.name)}`, {
                          disabled: false,
                          ...(projectWorkspace ? { workspace: projectWorkspace } : {}),
                        }),
                      ),
                  ).then(() => {
                    void qc.invalidateQueries({ queryKey: ['lib-skills'] });
                    setChecked(new Set());
                  });
                }}
              >
                Enable
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-2xs"
                onClick={() => {
                  void Promise.all(
                    rows
                      .filter((s) => checked.has(s.name))
                      .map((s) =>
                        api.patch(`/api/skills/${encodeURIComponent(s.name)}`, {
                          disabled: true,
                          ...(projectWorkspace ? { workspace: projectWorkspace } : {}),
                        }),
                      ),
                  ).then(() => {
                    void qc.invalidateQueries({ queryKey: ['lib-skills'] });
                    setChecked(new Set());
                  });
                }}
              >
                Disable
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-2xs text-danger-fg"
                onClick={() => {
                  const targets = rows.filter((s) => checked.has(s.name) && s.scope !== 'bundled');
                  if (targets.length === 0) {
                    toast.error('Bundled skills cannot be removed from here');
                    return;
                  }
                  void confirm({
                    title: `Remove ${targets.length} skills?`,
                    message: 'They move to the skill trash and can be restored from the tools door.',
                    confirmLabel: 'Remove',
                    variant: 'destructive',
                  }).then((ok) => {
                    if (!ok) return;
                    void Promise.all(
                      targets.map((s) =>
                        api.delete(
                          `/api/skills/${encodeURIComponent(s.name)}${projectWorkspace ? `?workspace=${encodeURIComponent(projectWorkspace)}` : ''}`,
                        ),
                      ),
                    ).then(() => {
                      void qc.invalidateQueries({ queryKey: ['lib-skills'] });
                      setChecked(new Set());
                    });
                  });
                }}
              >
                Remove
              </Button>
            </span>
          </div>
        ) : null}

        <div className={cn(SKILL_COLS, 'items-center gap-2 border-y border-border/50 px-4 py-1.5', MICRO_LABEL)}>
          <CheckCell
            checked={pageRows.length > 0 && pageRows.every((s) => checked.has(s.name))}
            label="Select all rows on this page"
            onToggle={() => {
              const all = pageRows.every((s) => checked.has(s.name));
              const next = new Set(checked);
              for (const s of pageRows) {
                if (all) next.delete(s.name);
                else next.add(s.name);
              }
              setChecked(next);
            }}
          />
          <div>Skill</div>
          <div className={CELL}>Version</div>
          <div className={cn(CELL, 'text-center')}>State</div>
          <div className={CELL}>Last used</div>
          <div />
        </div>

        {skillsQ.isPending ? (
          <div className="px-4 py-6 text-2xs text-muted-foreground">Loading skills…</div>
        ) : pageRows.length === 0 ? (
          <EmptyRows title="No skills match." hint="Clear the search or the source filter to see the rest of the library." />
        ) : (
          Array.from(groups.entries()).map(([label, list]) => (
            <div key={label}>
              {/* The count is of THIS page — a group head sits over a paged
                  slice, so it never claims the scope's whole total. */}
              <GroupHead label={label} count={`${list.length} on this page`} />
              {list.map((s) => (
                <div
                  key={s.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveName(s.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActiveName(s.name);
                    }
                  }}
                  className={cn(
                    SKILL_COLS,
                    'items-center gap-2 border-b border-border/40 px-4 py-2 transition-colors hover:bg-muted/40',
                    // The mockup's active row: a 2px accent inset on the left
                    // edge plus the faint tint (`.row[data-active="true"]`).
                    s.name === active?.name &&
                      'bg-primary/5 shadow-[inset_2px_0_0_0_var(--dt-primary)]',
                    !s.enabled && 'opacity-70',
                  )}
                >
                  <CheckCell
                    checked={checked.has(s.name)}
                    label={`Select ${s.name}`}
                    onToggle={() => {
                      const next = new Set(checked);
                      if (next.has(s.name)) next.delete(s.name);
                      else next.add(s.name);
                      setChecked(next);
                    }}
                  />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <div className="min-w-0 truncate text-2xs font-medium text-foreground">{s.name}</div>
                      {s.status && s.status !== 'active' ? <Pill tone="warn">{s.status}</Pill> : null}
                      {s.overrides ? <Pill tone="accent">override</Pill> : null}
                    </div>
                    <div className="mt-0.5 min-w-0">
                      <div className="min-w-0 truncate font-mono text-3xs text-muted-foreground/70">
                        {s.description}
                      </div>
                    </div>
                  </div>
                  <div className={cn(CELL, 'font-mono text-3xs text-muted-foreground/80')}>v{s.version || 1}</div>
                  <div className={cn(CELL, 'flex justify-center')}>
                    <RowSwitch
                      checked={s.enabled}
                      busy={patchMut.isPending}
                      label={`Toggle ${s.name}`}
                      onChange={() => patchMut.mutate({ name: s.name, disabled: s.enabled })}
                    />
                  </div>
                  <div className={cn(CELL, 'font-mono text-3xs text-muted-foreground/80')}>
                    {s.lastUsed ? timeAgo(s.lastUsed) : 'never'}
                  </div>
                  <div className="flex justify-end">
                    <Kebab
                      items={[
                        { label: 'Open detail', onSelect: () => setActiveName(s.name) },
                        { label: s.enabled ? 'Disable' : 'Enable', onSelect: () => patchMut.mutate({ name: s.name, disabled: s.enabled }) },
                        { label: 'Copy name', onSelect: () => void navigator.clipboard?.writeText(s.name) },
                        ...(s.scope === 'bundled'
                          ? []
                          : [{ label: 'Remove', onSelect: () => deleteMut.mutate(s.name), danger: true }]),
                      ]}
                    />
                  </div>
                </div>
              ))}
            </div>
          ))
        )}

        <RangeFooter
          from={rows.length === 0 ? 0 : page * PAGE_SIZE + 1}
          to={Math.min(rows.length, (page + 1) * PAGE_SIZE)}
          total={rows.length}
          page={page}
          pages={totalPages}
          onPrev={() => setPage(Math.max(0, page - 1))}
          onNext={() => setPage(Math.min(totalPages - 1, page + 1))}
          onPage={setPage}
        />
      </div>

      <aside
        data-testid="library-detail"
        className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card min-[1500px]:sticky min-[1500px]:top-3"
      >
        {active ? (
          <>
            <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
              <div className="min-w-0 truncate text-2xs font-semibold text-foreground">Skill detail</div>
              <div className={cn('ml-auto shrink-0', MICRO_LABEL)}>{skillSourceLabel(active.scope)}</div>
            </div>
            <div className="px-3.5 py-3.5">
              <div className="truncate font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground/70">
                {active.createdBy || 'August'} / v{active.version || 1}
              </div>
              <h3 className="mt-1.5 font-editorial text-[1.4rem] leading-[1.15] font-medium tracking-[-0.02em] text-foreground">
                {active.name}
              </h3>
              <div className="mt-2.5 flex flex-wrap gap-1">
                <Pill tone={active.scope === 'bundled' ? 'accent' : 'muted'}>{skillSourceLabel(active.scope)}</Pill>
                <Pill>{active.enabled ? 'enabled' : 'disabled'}</Pill>
                {active.origin ? <Pill tone="muted">{active.origin}</Pill> : null}
              </div>
              <p className="mt-2.5 text-2xs leading-relaxed text-foreground/85">{active.description}</p>

              <DetailSectionTitle>What it does</DetailSectionTitle>
              <div className="mt-1.5 max-h-44 overflow-y-auto rounded-md border border-border/60 bg-muted/30 p-2 font-mono text-3xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {detailQ.isPending
                  ? 'Loading SKILL.md…'
                  : str(detailQ.data?.instructions ?? detailQ.data?.body ?? '') || '(no body)'}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <DetailCell label="State" value={active.enabled ? 'Enabled' : 'Disabled'} />
                <DetailCell label="Last used" value={active.lastUsed ? `${timeAgo(active.lastUsed)} ago` : 'never'} />
                <DetailCell label="Uses" value={`${active.usageCount} times`} />
                <DetailCell label="Category" value={active.category} />
              </div>

              {/* No section title here: SkillVersionsPanel brings its own
                  heading, and two "Version history" rules stacked. */}
              <div className="mt-4">
                <SkillVersionsPanel name={active.name} workspace={active.scope === 'project' ? projectWorkspace : undefined} />
              </div>

              <div className="mt-4 flex flex-wrap gap-1.5">
                <Button size="sm" onClick={() => patchMut.mutate({ name: active.name, disabled: active.enabled })}>
                  {active.enabled ? 'Disable' : 'Enable'}
                </Button>
                {active.scope !== 'bundled' ? (
                  <Button size="sm" variant="outline" className="text-danger-fg" onClick={() => deleteMut.mutate(active.name)}>
                    Remove
                  </Button>
                ) : (
                  <p className="text-3xs leading-relaxed text-muted-foreground">
                    Bundled skills ship with August and cannot be removed here.
                  </p>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="p-4">
            <div className="text-2xs font-semibold">Detail</div>
            <p className="mt-1 text-3xs leading-relaxed text-muted-foreground">
              Select a skill to read its SKILL.md, its usage, and its version history.
            </p>
          </div>
        )}
      </aside>
      <ConfirmState state={confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
    </section>
  );
}

function NewSkillForm({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string, description: string, body: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  return (
    <div className="mx-4 mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <div className="text-2xs font-medium text-foreground">New skill</div>
        <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-3xs" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="mt-2 space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name (lowercase, hyphenated)"
          aria-label="Skill name"
          className="w-full rounded-md border border-border/60 bg-card px-2 py-1.5 text-2xs outline-none focus:border-primary/40"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="What it does and when to use it — this is the trigger a future agent sees first."
          aria-label="Skill description"
          className="w-full rounded-md border border-border/60 bg-card px-2 py-1.5 text-2xs outline-none focus:border-primary/40"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder="SKILL.md body"
          aria-label="Skill body"
          className="w-full rounded-md border border-border/60 bg-card px-2 py-1.5 font-mono text-3xs outline-none focus:border-primary/40"
        />
        <Button
          size="sm"
          className="ml-auto"
          disabled={busy || name.trim() === '' || description.trim() === ''}
          onClick={() => onCreate(name.trim(), description.trim(), body)}
        >
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </div>
  );
}

/* ── the page ──────────────────────────────────────────────────────── */

export function LibrarySection({ active }: { active: SettingsSection }) {
  const navigate = useNavigate();
  const view: 'memory' | 'skills' = active.id === 'skills' ? 'skills' : 'memory';
  const storesQ = useQuery<{ stores: StoreInfo[] }>({
    queryKey: ['brain-stores'],
    queryFn: () => api.get<{ stores: StoreInfo[] }>('/api/brain/stores'),
  });
  const workspacesQ = useQuery<{ workspaces: WorkspaceInfo[] }>({
    queryKey: ['memory-workspaces'],
    queryFn: () => api.get<{ workspaces: WorkspaceInfo[] }>('/api/august/memory/workspaces'),
  });
  const skillsQ = useQuery<{ skills: SkillRow[] }>({
    queryKey: ['lib-skills-all'],
    queryFn: () => api.get<{ skills: SkillRow[] }>('/api/skills'),
  });

  const counts = (store: string) => storesQ.data?.stores.find((s) => s.name === store)?.count ?? 0;
  const memoryTotal = MEM_STORES.reduce((n, s) => n + counts(s), 0);
  const withMemory = useMemo(
    () => (workspacesQ.data?.workspaces ?? []).filter((w) => w.hasMemory),
    [workspacesQ.data],
  );
  const withSkills = useMemo(
    () => (workspacesQ.data?.workspaces ?? []).filter((w) => w.hasSkills),
    [workspacesQ.data],
  );

  return (
    <div className="august-library mx-auto w-full max-w-[1420px] px-4 pb-10 sm:px-6">
      {/* The Settings hero above already says "Settings", so the page does not
          restate it: the container name is the one thing the hero does not
          carry. */}
      <h2 className="font-editorial text-[1.75rem] leading-[1.15] font-medium tracking-[-0.025em] text-foreground">
        Library
      </h2>
      <p className="mt-1.5 max-w-[64ch] text-2xs leading-relaxed text-muted-foreground">
        Memory facts and skills, one list-and-detail pattern for a library that has to stay usable
        at a thousand rows.
      </p>

      <div className="mt-4 flex items-center gap-1 border-b border-border/60 pb-2.5" role="tablist" aria-label="Library view">
        <Button
          role="tab"
          aria-selected={view === 'memory'}
          variant="ghost"
          className={cn(
            'h-8 gap-2 rounded-md px-3 text-2xs',
            view === 'memory' ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
          onClick={() => void navigate('/settings/memory-knowledge')}
        >
          <BookOpen className="size-3.5" /> Memory
          <span className={cn('font-mono text-3xs', view === 'memory' ? 'text-primary' : 'text-muted-foreground/70')}>
            {memoryTotal.toLocaleString('en-US')}
          </span>
        </Button>
        <Button
          role="tab"
          aria-selected={view === 'skills'}
          variant="ghost"
          className={cn(
            'h-8 gap-2 rounded-md px-3 text-2xs',
            view === 'skills' ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
          onClick={() => void navigate('/settings/skills')}
        >
          <Layers className="size-3.5" /> Skills
          <span className={cn('font-mono text-3xs', view === 'skills' ? 'text-primary' : 'text-muted-foreground/70')}>
            {(skillsQ.data?.skills.length ?? 0).toLocaleString('en-US')}
          </span>
        </Button>
      </div>

      <div className="mt-3.5">
        {view === 'memory' ? (
          <MemoryLibrary counts={counts} totalCount={memoryTotal} projectWorkspaces={withMemory} />
        ) : (
          <SkillsLibrary workspaces={withSkills} />
        )}
      </div>
    </div>
  );
}

export default LibrarySection;
