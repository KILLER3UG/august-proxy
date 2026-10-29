/* ── Skills — Claude-style catalogue + detail viewer (0.17.0) ───────── */
/* List view: one hairline row per skill, grouped by the scope that       */
/* decides whether it shadows another.                                     */
/* Detail view: a facts strip (usage, lineage, open learning proposals)    */
/* over the rendered SKILL.md, with the enabled toggle, edit / delete and  */
/* create forms. Bundled skills are copy-on-write.                         */
/* Workspace scope selector (project skills merge in   */
/* with shadowing, C-1), scope + overrides badges (C-2), and the write  */
/* paths (create/edit/delete/toggle) route through the selected scope.  */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listSkillSuggestions } from '@/api/api-client/skills-versions';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronLeft,
  FolderTree,
  Info,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Power,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { QueryErrorState } from '@/components/QueryErrorState';
import { SectionHeader } from '@/components/SectionHeader';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { settingsTabPanelId } from '@/components/settings/settingsTabIds';
import { ValuePill, type ValuePillOption } from '@/components/ui/ValuePill';
import { LearningPanel } from '@/sections/settings/LearningPanel';
import { HarnessImprovementsSection } from './HarnessImprovementsSection';
import { SkillPacksPanel } from '@/sections/settings/SkillPacksPanel';
import { SkillVersionsPanel } from '@/sections/settings/SkillVersionsPanel';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { inboxRoute, type LearningHost } from '@/sections/learning/host';
import { cn } from '@/lib/utils';

interface SkillSummary {
  name: string;
  description: string;
  trigger: string;
  category: string;
  enabled: boolean;
  createdBy: string;
  scope?: string;
  overrides?: string;
  /** Trigger hits from the per-skill usage sidecar. The server always sends
   *  both fields for a listed skill; optional here only because a cached
   *  `skills-list` response from before this shipped has no such key. */
  usageCount?: number;
  lastUsed?: string;
  /** The skill this one replaced, when an approved learning proposal
   *  superseded an older behaviour. The applier disables the older skill in
   *  the same write, so this is the pair that says "v2 of what I learned". */
  supersedes?: string;
  /** Who wrote the current version: human | distilled | amended. Only
   *  proposal-approved skills carry it, so its absence means hand-authored. */
  origin?: string;
  /** How many approved patches this skill has had. 1 is the original write. */
  version?: number;
}

interface SkillDetail extends SkillSummary {
  instructions: string;
}

/** The open rows of the learning queue that name this skill — the same
 *  records the Review Inbox lists, so the skills page can say what is
 *  waiting without duplicating the decision UI. */
interface OpenSkillProposal {
  id: string;
  kind: string;
  proposal?: string;
  payload?: { name?: string };
}

interface WorkspaceInfo {
  path: string;
  name: string;
  hasMemory?: boolean;
  hasSkills?: boolean;
  sessions?: number;
}

type Mode = 'list' | 'detail' | 'create' | 'edit';

const EMPTY_FORM = { name: '', description: '', body: '', trigger: '', category: 'uncategorized' };

/** The catalogue renders in TWO hosts — the Settings panel and the Learning
 *  hub's Skills tab — and it renders the SAME shape in both: the same
 *  `SectionHeader`, the same toolbar, the same grid. The nav in front of it
 *  carries the icon and the name in both hosts, so a host-specific variant
 *  would only ever be a way for the same page to look like two pages.
 *
 *  The ONE thing that differs is a link that LEAVES the surface: the skill
 *  detail's "Review inbox" has to land on the inbox in the host the reader
 *  is in, or the Learning hub throws you into the Settings overlay. That is
 *  `inboxRoute(host)` and it is the whole of the difference. */
type SkillSort = 'name' | 'recent' | 'usage' | 'effect';

/* The sort is a VALUE, and the reference's value control is a pill. A native
 * <select> draws the platform's own dropdown and ignores the theme, which is
 * why every other select in Settings moved to the app's own listbox. */
const SORT_OPTIONS: ValuePillOption<SkillSort>[] = [
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Recently used' },
  { value: 'usage', label: 'Most used' },
  { value: 'effect', label: 'Measured effect' },
];

export function SkillsSection({ host = 'settings' }: { host?: LearningHost } = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('list');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Debounced mirror of `search` — the React Query key changes only on
  // the trailing edge, so each keystroke doesn't fan out to /api/skills
  // and re-render the entire card grid (audit finding).
  const [searchDebounced, setSearchDebounced] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setSearchDebounced(search), 200);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [seeMore, setSeeMore] = useState(false);
  // C-1: '' = global scope, a path = that project's merged view.
  const [wsScope, setWsScope] = useState('');
  const [trustBusy, setTrustBusy] = useState(false);

  const trustQuery = useQuery<{
    trusted: boolean;
    hasProjectRoot: boolean;
    pending: Array<{ name: string; description: string }>;
  }>({
    queryKey: ['skills-trust', wsScope],
    queryFn: () =>
      api.get<{
        trusted: boolean;
        hasProjectRoot: boolean;
        pending: Array<{ name: string; description: string }>;
      }>(`/api/skills/trust?workspace=${encodeURIComponent(wsScope)}`),
    enabled: !!wsScope,
    staleTime: 10_000,
  });

  const setProjectTrust = async (trusted: boolean) => {
    if (!wsScope || trustBusy) return;
    setTrustBusy(true);
    try {
      await api.post(
        trusted ? '/api/skills/trust' : '/api/skills/revoke-trust',
        { workspace: wsScope },
      );
      await queryClient.invalidateQueries({ queryKey: ['skills-trust'] });
      await queryClient.invalidateQueries({ queryKey: ['skills-list'] });
      await queryClient.invalidateQueries({ queryKey: ['skill-detail'] });
      toast.success(
        trusted
          ? 'Project skills trusted for this workspace'
          : 'Project skills are inactive again',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update project-skill trust');
    } finally {
      setTrustBusy(false);
    }
  };

  const workspacesQ = useQuery<{ workspaces: WorkspaceInfo[] }>({
    queryKey: ['memory-workspaces'],
    queryFn: () => api.get<{ workspaces: WorkspaceInfo[] }>('/api/august/memory/workspaces'),
  });

  const listQuery = useQuery({
    queryKey: ['skills-list', searchDebounced, wsScope],
    queryFn: () => {
      const params = new URLSearchParams();
      if (searchDebounced) params.set('q', searchDebounced);
      if (wsScope) params.set('workspace', wsScope);
      const qs = params.toString();
      return api.get<{ skills: SkillSummary[]; total: number }>(`/api/skills${qs ? `?${qs}` : ''}`);
    },
    staleTime: 30_000,
  });

  const detailQuery = useQuery({
    queryKey: ['skill-detail', selectedName, wsScope],
    queryFn: () => {
      const params = new URLSearchParams();
      if (wsScope) params.set('workspace', wsScope);
      const qs = params.toString();
      return api.get<SkillDetail>(
        `/api/skills/${encodeURIComponent(selectedName ?? '')}${qs ? `?${qs}` : ''}`,
      );
    },
    enabled: !!selectedName && (mode === 'detail' || mode === 'edit'),
  });

  // Keyed exactly like the Review Inbox's own request so the two share one
  // cache entry: approving there invalidates the line here, and opening a
  // skill never fires a second proposals fetch while the inbox is mounted.
  const proposalsQ = useQuery<{ proposals: OpenSkillProposal[] }>({
    queryKey: ['harness-proposals', 'open'],
    queryFn: () =>
      api.get<{ proposals: OpenSkillProposal[] }>('/api/harness/proposals?status=open'),
    enabled: mode === 'detail',
    staleTime: 30_000,
  });

  const refresh = useCallback(() => {    void queryClient.invalidateQueries({ queryKey: ['skills-list'] });
    void queryClient.invalidateQueries({ queryKey: ['skill-detail', selectedName] });
    void queryClient.invalidateQueries({ queryKey: ['memory-workspaces'] });
  }, [queryClient, selectedName]);

  useEffect(() => {
    if (mode !== 'detail') setSeeMore(false);
  }, [mode]);

  // Switching scope drops the open detail — the skill may not exist there.
  useEffect(() => {
    setSelectedName(null);
    setMode('list');
    setConfirmDelete(null);
  }, [wsScope]);

  const skills = useMemo(() => listQuery.data?.skills ?? [], [listQuery.data]);
  // Grouped by the scope that decides whether a skill shadows another — the
  // distinction a reader needs before they read any description.
  const selected = detailQuery.data ?? null;
  const workspaces = workspacesQ.data?.workspaces ?? [];
  // What the learning loop wants changed about this skill right now. Matched
  // on payload.name because that is the key every skill applier reads.
  const openProposals = useMemo(() => {
    const rows = proposalsQ.data?.proposals ?? [];
    if (!selected?.name) return [];
    return rows.filter((p) => (p.payload?.name ?? '') === selected.name);
  }, [proposalsQ.data, selected?.name]);
  // The v1 this skill replaced. It stays in the catalogue (disabled) rather
  // than being deleted, so the pane can say which state it is in now.
  const superseded = useMemo(() => {
    const older = selected?.supersedes?.trim();
    if (!older || older === selected?.name) return null;
    return { name: older, row: skills.find((s) => s.name === older) ?? null };
  }, [skills, selected?.supersedes, selected?.name]);
  // Only fetched when a detail pane is open — the list never shows these.
  const suggestionsQuery = useQuery({
    queryKey: ['skill-suggestions', '30d'],
    queryFn: () => listSkillSuggestions(30, 50),
    staleTime: 10 * 60_000,
    enabled: !!selected,
  });

  // Sort: rows were grouped by scope but ordered by whatever the server sent
  // (spec §10.2 — "rows are grouped by scope but ordered by server response").
  const [sort, setSort] = useState<SkillSort>('name');
  const grouped = useMemo(() => {
    const out: Record<SkillScopeKey, SkillSummary[]> = { project: [], agent: [], bundled: [], other: [] };
    for (const s of skills) out[skillScopeKey(s)].push(s);
    const byName = (a: SkillSummary, b: SkillSummary) => a.name.localeCompare(b.name);
    const byRecent = (a: SkillSummary, b: SkillSummary) =>
      (b.lastUsed || '').localeCompare(a.lastUsed || '') || byName(a, b);
    const byUsage = (a: SkillSummary, b: SkillSummary) =>
      (b.usageCount ?? 0) - (a.usageCount ?? 0) || byName(a, b);
    const liftOf = (s: SkillSummary) =>
      suggestionsQuery.data?.suggestions.find((x) => x.skill === s.name)?.lift ?? -Infinity;
    const byEffect = (a: SkillSummary, b: SkillSummary) =>
      liftOf(b) - liftOf(a) || byName(a, b);
    const cmp = sort === 'recent' ? byRecent : sort === 'usage' ? byUsage : sort === 'effect' ? byEffect : byName;
    for (const key of Object.keys(out) as SkillScopeKey[]) out[key].sort(cmp);
    return out;
  }, [skills, sort, suggestionsQuery.data]);

  // The turn ledger's honest number: resolved rate on turns that carried
  // this skill vs turns that did not. Rendered for the first time here —
  // the endpoint's numbers existed since migration 050 and were visible
  // nowhere (2026-10-03).
  const liftFact = useMemo(() => {
    const row = suggestionsQuery.data?.suggestions.find((x) => x.skill === selected?.name);
    if (!row || row.turnsWith === 0) return null;
    const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
    const lift =
      row.lift == null
        ? 'not enough history to compare yet'
        : row.lift > 0.02
          ? `+${Math.round(row.lift * 100)} pts — turns with this skill resolve more often`
          : row.lift < -0.02
            ? `${Math.round(row.lift * 100)} pts — turns with this skill resolve less often`
            : 'no measurable difference';
    return `${pct(row.okRateWith)} on ${row.turnsWith} turns with it vs ${pct(row.okRateWithout)} on ${row.turnsWithout} without (${lift}).`;
  }, [suggestionsQuery.data, selected?.name]);
  // A failed /api/skills call is not an empty catalogue — the "No skills yet"
  // empty state (and its "author your first skill" prompt) must not stand in
  // for a transport error. The same applies to the detail pane, which used to
  // spin forever on a failed skill fetch.
  const listFailed = listQuery.isError && !listQuery.data;
  const detailFailed = detailQuery.isError && !selected;

  // Disambiguate same-basename workspaces with their parent dir
  // (seven leaked "proj" entries used to collapse into identical labels) and
  // carry the full path as the option title.
  const scopeOptions = useMemo(() => {
    const partsOf = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean);
    const nameCounts = new Map<string, number>();
    for (const w of workspaces) nameCounts.set(w.name, (nameCounts.get(w.name) ?? 0) + 1);
    return [
      { value: '', label: 'Global (all skills)', title: undefined as string | undefined },
      ...workspaces.map((w) => {
        const parts = partsOf(w.path);
        const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
        const dup = (nameCounts.get(w.name) ?? 0) > 1 && parent;
        const label =
          `${w.name}${dup ? ` (${parent})` : ''}${w.hasSkills ? ' · has project skills' : ''}`;
        return { value: w.path, label, title: w.path };
      }),
    ];
  }, [workspaces]);

  const openDetail = (name: string) => {
    setSelectedName(name);
    setSeeMore(false);
    setMode('detail');
  };

  const startCreate = () => {
    setForm(EMPTY_FORM);
    setMode('create');
  };

  const startEdit = () => {
    if (!selected) return;
    setForm({
      name: selected.name,
      description: selected.description,
      body: selected.instructions,
      trigger: selected.trigger,
      category: selected.category || 'uncategorized',
    });
    setMode('edit');
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (mode === 'create') {
        await api.post('/api/skills', { ...form, workspace: wsScope || undefined });
        toast.success(`Skill '${form.name}' created${wsScope ? ' in this project' : ''}`);
      } else if (mode === 'edit' && form.name) {
        await api.patch(
          `/api/skills/${encodeURIComponent(form.name)}`,
          {
            body: form.body,
            description: form.description,
            trigger: form.trigger,
            category: form.category,
            workspace: wsScope || undefined,
          },
        );
        toast.success('Skill saved');
      }
      refresh();
      setSelectedName(form.name || null);
      setMode(form.name ? 'detail' : 'list');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    setSaving(true);
    try {
      const params = new URLSearchParams();
      if (wsScope) params.set('workspace', wsScope);
      const qs = params.toString();
      const res = await api.delete<{ trashId?: string }>(
        `/api/skills/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`,
      );
      const trashId = res?.trashId;
      // The backend moves the directory to a 24h trash, so the toast can
      // offer a real Undo instead of "are you sure?" with no way back.
      // The Undo toast outlives the default ~4s: it is the only affordance
      // for a destructive action (the server keeps the copy 24h either way).
      toast.success(`Skill '${name}' deleted${wsScope ? ' from this project' : ''}`, {
        duration: trashId ? 15_000 : undefined,
        action: trashId
          ? {
              label: 'Undo',
              onClick: () => {
                void api
                  .post(`/api/skills/restore/${encodeURIComponent(trashId)}`)
                  .then(() => {
                    toast.success(`Restored '${name}'`);
                    // `refresh()` invalidates ['skills-list'] (plus detail and
                    // workspaces). Invalidating ['skills'] matched no query —
                    // the skill came back on disk but the list stayed stale
                    // (live-found 2026-10-04).
                    refresh();
                    setSelectedName(null);
                  })
                  .catch((err: unknown) => {
                    toast.error(
                      `Restore failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  });
              },
            }
          : undefined,
        description: trashId ? 'Recoverable for 24 hours.' : undefined,
      });
      setConfirmDelete(null);
      if (selectedName === name) {
        setSelectedName(null);
        setMode('list');
      }
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setSaving(false);
    }
  };

  // Bulk selection for enable/disable (a dozen one-at-a-time switches is
  // how nobody curates a catalogue).
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Scope pill filter. `null` = All, which preserves the previous behaviour
  // of listing every scope in its own section.
  const [scopeTab, setScopeTab] = useState<SkillScopeKey | 'all'>('all');
  // Derived from the FILTERED set, never from `grouped` wholesale: under a
  // scope tab, select-all must pick only what is on screen. Deriving it from
  // all groups silently enables/disables skills the user cannot see — the
  // one bulk action whose blast radius is invisible while it happens.
  const allVisible = useMemo(
    () =>
      (scopeTab === 'all'
        ? Object.values(grouped).flat()
        : (grouped[scopeTab] ?? [])
      ).map((s) => s.name),
    [grouped, scopeTab],
  );
  const togglePicked = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  const bulkSetDisabled = async (disabled: boolean) => {
    const names = [...picked];
    if (names.length === 0) return;
    setSaving(true);
    try {
      await Promise.all(
        names.map((name) =>
          api.patch(`/api/skills/${encodeURIComponent(name)}`, {
            disabled,
            ...(wsScope ? { workspace: wsScope } : {}),
          }),
        ),
      );
      toast.success(
        `${names.length} skill${names.length === 1 ? '' : 's'} ${disabled ? 'disabled' : 'enabled'}`,
      );
      setPicked(new Set());
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk update failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (name: string, currently: boolean) => {
    try {
      await api.patch(`/api/skills/${encodeURIComponent(name)}`, {
        disabled: currently, // sending disabled=true flips it off
        ...(wsScope ? { workspace: wsScope } : {}),
      });
      toast.success(currently ? `'${name}' disabled` : `'${name}' enabled`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update skill');
    }
  };

  const isFormMode = mode === 'create' || mode === 'edit';
  const headerLabel =
    mode === 'list'
      ? 'Skills'
      : isFormMode
        ? mode === 'create'
          ? 'Create skill'
          : `Edit ${selected?.name ?? ''}`
        : selected?.name ?? '…';

  return (
    <div className="px-8 py-6 space-y-5 h-full flex flex-col overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────────── */}
      {mode === 'list' ? (
        /* The panel-section header — NO icon, because the nav in front of it
         * already carries the icon and the name (the settings rail and the
         * hub's own rail are the same instrument). See the header grammar in
         * sections/learning/LearningHub.tsx.
         * ONE header for BOTH hosts: the same page must not look like two
         * different pages depending on how you got here. */
        <SectionHeader
          title="Skills"
          className="mb-0 shrink-0"
          subtitle={
            listFailed
              ? "Couldn't load skills"
              : `${skills.length} skill${skills.length === 1 ? '' : 's'} · loaded progressively into chat when relevant`
          }
          actions={
            <>
              {/* Search is a PILL with a border — the reference's own search
                  affordance, not a bare magnifier that hides one on click. */}
              <div className="relative w-56">
                <Search className="absolute left-3 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search skills…"
                  aria-label="Search skills"
                  className="h-8 w-full rounded-full border border-border/60 bg-card/60 pl-9 pr-3 text-xs placeholder:text-muted-foreground/70 focus:border-primary/40 focus:outline-none"
                />
              </div>
              <div data-testid="skills-sort">
                <ValuePill
                  ariaLabel="Sort skills"
                  value={sort}
                  options={SORT_OPTIONS}
                  onChange={(v) => setSort(v)}
                />
              </div>
              {/* The ONE primary action on this surface. */}
              <Button onClick={startCreate}>
                <Plus className="size-4" /> New
              </Button>
            </>
          }
        />
      ) : (
        /* The detail / form header is a DIFFERENT thing — the reference's
         * detail-view grammar: a back link at the left, the name beside it,
         * the actions at the right. */
        <header className="shrink-0 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() =>
                isFormMode && selected
                  ? setMode('detail')
                  : (setSelectedName(null), setMode('list'))
              }
              className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label="Back"
            >
              {isFormMode ? <ChevronLeft className="size-4" /> : <ArrowLeft className="size-4" />}
            </button>
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold tracking-tight text-foreground">{headerLabel}</h2>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {mode === 'detail' && selected && (
              <>
                <Button variant="outline" onClick={startEdit}>
                  <Pencil className="size-3" /> Edit
                </Button>
                {/* M6 item 7: deletable only when authored (non-bundled) origin.
                    Bundled skills carry an empty createdBy; also treat explicit
                    'builtin'/'bundled' markers as non-deletable. A project
                    override (scope=project) is always deletable — removing it
                    only restores the global copy it shadows. */}
                {(selected.scope === 'project' ||
                  (selected.createdBy &&
                    selected.createdBy !== 'builtin' &&
                    selected.createdBy !== 'bundled')) && (
                  <Button
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => setConfirmDelete(selected.name)}
                  >
                    <Trash2 className="size-3" /> Delete
                  </Button>
                )}
              </>
            )}
            {isFormMode && (
              <>
                <Button onClick={() => void handleSave()} disabled={saving}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  Save
                </Button>
                <Button
                  variant="outline"
                  onClick={() => (selected ? setMode('detail') : setMode('list'))}
                >
                  <X className="size-4" /> Cancel
                </Button>
              </>
            )}
          </div>
        </header>
      )}

      {/* ── List ────────────────────────────────────────────────────── */}
      {mode === 'list' && (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="skills-grid">
          {listQuery.isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : listFailed ? (
            <QueryErrorState
              error={listQuery.error}
              onRetry={() => void listQuery.refetch()}
              retrying={listQuery.isRefetching}
              title="Couldn't load skills"
              note="Your skills may still exist — the catalogue request failed, so this is not an empty list."
            />
          ) : skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
              <BookOpen className="mb-3 size-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No skills yet — click New to author your first skill.
              </p>
            </div>
          ) : (
            /* One hairline row per skill, grouped by the scope that decides
             * whether it shadows another — the card grid buried the only
             * distinction that matters when a catalogue grows. */
            <div className="space-y-2" data-testid="skill-rows">
              {/* ONE filter band. The page used to stack four bands above
                  the list — a scope row with its own label and select, a
                  packs card, a learning card, and a bulk row — before a
                  single skill was visible. */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Scope pills (Claude-style), not per-scope sections. The
                    component auto-flips to a vertical rail at 5+ items, so
                    orientation is pinned: four scopes plus "All" would
                    silently become a left rail. */}
                <SettingsTabs
                  value={scopeTab}
                  onChange={(k) => setScopeTab(k as SkillScopeKey | 'all')}
                  orientation="horizontal"
                  label="Skill scope"
                  panelIdPrefix="skill-scope"
                  items={[
                    { key: 'all', label: 'All', count: skills.length },
                    ...SKILL_SCOPE_GROUPS.map(({ key, label }) => ({
                      key,
                      label,
                      count: grouped[key]?.length ?? 0,
                    })),
                  ]}
                />
                {/* C-1: the project scope. It was a band of its own with an
                    uppercase label; it is a filter, so it sits with the
                    other filters. */}
                <div className="ml-auto flex min-w-0 items-center gap-2" data-testid="skills-scope-row">
                  <FolderTree className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                  <div className="shrink-0" data-testid="skills-scope-select">
                    <ValuePill
                      ariaLabel="Skills scope"
                      value={wsScope}
                      options={scopeOptions}
                      onChange={(v) => setWsScope(v)}
                    />
                  </div>
                </div>
              </div>
              {wsScope && (
                <p className="px-1 text-2xs text-muted-foreground/70">
                  Project skills shadow same-named global ones
                </p>
              )}
              {wsScope &&
              trustQuery.data &&
              (trustQuery.data.pending.length > 0 ||
                (!trustQuery.data.trusted && trustQuery.data.hasProjectRoot)) ? (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-xs"
                  data-testid="skills-trust-banner"
                >
                  {trustQuery.data.trusted ? (
                    <>
                      <ShieldCheck className="size-3.5 shrink-0 text-success-fg" aria-hidden />
                      <span className="min-w-0 flex-1 text-muted-foreground">
                        Project skills are trusted for this workspace.{' '}
                        {trustQuery.data.pending.length > 0
                          ? `${trustQuery.data.pending.length} skill${
                              trustQuery.data.pending.length === 1 ? '' : 's'
                            } loaded from it.`
                          : ''}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={trustBusy}
                        onClick={() => void setProjectTrust(false)}
                      >
                        {trustBusy ? <Loader2 className="size-3 animate-spin" /> : null}
                        Revoke
                      </Button>
                    </>
                  ) : (
                    <>
                      <ShieldAlert className="size-3.5 shrink-0 text-warning-fg" aria-hidden />
                      <span className="min-w-0 flex-1 text-muted-foreground">
                        This workspace defines {trustQuery.data.pending.length} project skill
                        {trustQuery.data.pending.length === 1 ? '' : 's'} (
                        {trustQuery.data.pending
                          .slice(0, 4)
                          .map((p) => p.name)
                          .join(', ')}
                        {trustQuery.data.pending.length > 4
                          ? ` +${trustQuery.data.pending.length - 4}`
                          : ''}
                        ). They are inactive until you trust this workspace.
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={trustBusy}
                        onClick={() => void setProjectTrust(true)}
                      >
                        {trustBusy ? <Loader2 className="size-3 animate-spin" /> : null}
                        Trust project skills
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
              {/* Bulk actions — select-all plus the two state switches. */}
              <div className="flex items-center gap-2 px-1" data-testid="skills-bulk">
                <label className="flex items-center gap-1.5 text-2xs text-muted-foreground/70">
                  <input
                    type="checkbox"
                    checked={allVisible.length > 0 && picked.size === allVisible.length}
                    onChange={(e) =>
                      setPicked(e.target.checked ? new Set(allVisible) : new Set())
                    }
                    aria-label="Select all skills"
                    data-testid="skills-select-all"
                    className="size-3 accent-[var(--dt-primary)]"
                  />
                  {picked.size > 0
                    ? `${picked.size} selected`
                    : 'Select for bulk actions'}
                </label>
                {picked.size > 0 && (
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={saving}
                      onClick={() => void bulkSetDisabled(false)}
                      data-testid="skills-bulk-enable"
                    >
                      Enable
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={saving}
                      onClick={() => void bulkSetDisabled(true)}
                      data-testid="skills-bulk-disable"
                    >
                      Disable
                    </Button>
                  </div>
                )}
              </div>
              <div
                role="tabpanel"
                id={settingsTabPanelId('skill-scope', scopeTab) ?? undefined}
                aria-labelledby={`skill-scope-tab-${scopeTab}`}
              >
              {(() => {
                const shown =
                  scopeTab === 'all'
                    ? SKILL_SCOPE_GROUPS.filter((g) => (grouped[g.key]?.length ?? 0) > 0)
                    : SKILL_SCOPE_GROUPS.filter((g) => g.key === scopeTab);
                const note = SKILL_SCOPE_GROUPS.find((g) => g.key === scopeTab)?.note;
                return (
                  <>
                    {scopeTab !== 'all' && note && (
                      <p className="text-2xs text-muted-foreground/70">{note}</p>
                    )}
                    {shown.map(({ key, label }) => {
                      const group = grouped[key] ?? [];
                      return (
                        <section key={key} data-testid={`skill-group-${key}`}>
                          {scopeTab === 'all' && (
                            /* The reference's section label: bold, sentence
                               case, with the hairline rule running to the
                               right edge. The old label was a tiny uppercase
                               tracked-out string. */
                            <h3 className="flex items-baseline gap-2 border-b border-border/60 pb-1.5 text-sm font-semibold text-foreground">
                              {label}
                              <span className="text-2xs font-normal text-muted-foreground/60">
                                {group.length}
                              </span>
                            </h3>
                          )}
                          <div className="grid gap-2 sm:grid-cols-2">
                            {group.map((s) => (
                              <SkillCard
                                key={s.name}
                                skill={s}
                                selected={picked.has(s.name)}
                                onToggleSelect={() => togglePicked(s.name)}
                                onOpen={() => openDetail(s.name)}
                                onToggleEnabled={() =>
                                  void toggleEnabled(s.name, s.enabled !== false)
                                }
                              />
                            ))}
                          </div>
                        </section>
                      );
                    })}
                  </>
                );
              })()}
              </div>
            </div>
          )}

          {/* The secondary surfaces sit BELOW the catalogue now. The list is
              what this page is for, and a packs form used to sit above it.

              ONE container with hairline children: two bordered boxes
              stacked under the grid is the "N bordered cards" the reference
              rules out. The Learning panel drops its own frame here and
              keeps it in the Learning hub, where it stands alone. */}
          <div className="mt-4 overflow-hidden rounded-xl border border-border/60 bg-card/60">
            {/* The review queue for THIS surface: the skills and settings the
                learning loop wants to write. It used to be a Settings section of
                its own, which is how proposals piled up in a place nobody
                opened — the decision belongs where the change lands. */}
            <HarnessImprovementsSection scope="skills" framed={false} />
            {/* Part 16 Phase E: Learning (curator report + drafts). */}
            <LearningPanel framed={false} />
            {/* Skill packs: install-from-remote. */}
            <SkillPacksPanel />
          </div>
        </div>
      )}

      {/* ── Detail (Claude-style) ───────────────────────────────────── */}
      {mode === 'detail' && (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {detailQuery.isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !selected ? (
            // A failed skill fetch used to spin forever here. Say it failed.
            detailFailed ? (
              <QueryErrorState
                error={detailQuery.error}
                onRetry={() => void detailQuery.refetch()}
                retrying={detailQuery.isRefetching}
                title={`Couldn't load ${selectedName ?? 'this skill'}`}
                note="The skill may still exist — its request failed, so nothing is shown here."
              />
            ) : (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )
          ) : (
            <div className="mx-auto max-w-3xl space-y-4" data-testid="skill-detail">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {/* The facts are metadata now, not badges: who wrote it,
                      what category it is in, which scope it came from and
                      what it shadows — one muted line, the way the reference
                      says a detail header does it. */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[0.9375rem] font-semibold text-foreground">{selected.name}</span>
                    <span className="inline-flex cursor-default items-center gap-1 text-2xs text-muted-foreground">
                      <Info className="size-3" />
                      {selected.createdBy ? `by ${selected.createdBy}` : 'bundled'}
                    </span>
                    {selected.category && selected.category !== 'uncategorized' && (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                        <span className="text-2xs capitalize text-muted-foreground/80" data-testid="skill-category-note">
                          {selected.category}
                        </span>
                      </>
                    )}
                    {selected.scope && (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                        <span className="text-2xs text-muted-foreground/80" data-testid="skill-scope-badge">
                          {selected.scope}
                        </span>
                      </>
                    )}
                    {selected.overrides && (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                        <span className="text-2xs text-muted-foreground/80" data-testid="skill-overrides-badge">
                          overrides {selected.overrides}
                        </span>
                      </>
                    )}
                  </div>
                  <p className={cn('mt-1 text-[0.78125rem] leading-relaxed text-muted-foreground', !seeMore && 'line-clamp-2')}>
                    {selected.description || 'No description.'}
                    {!seeMore && selected.description.length > 140 && (
                      <button
                        type="button"
                        onClick={() => setSeeMore(true)}
                        className="ml-1 font-medium text-primary hover:underline"
                      >
                        See more
                      </button>
                    )}
                  </p>
                  {seeMore && selected.description.length > 140 && (
                    <button
                      type="button"
                      onClick={() => setSeeMore(false)}
                      className="text-2xs font-medium text-primary hover:underline"
                    >
                      See less
                    </button>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2 pt-1">
                  <span
                    className="text-2xs text-muted-foreground"
                    id={`skill-enabled-label-${selected.name}`}
                  >
                    {selected.enabled === false ? 'Disabled' : 'Enabled'}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={selected.enabled !== false}
                    aria-labelledby={`skill-enabled-label-${selected.name}`}
                    onClick={() => void toggleEnabled(selected.name, selected.enabled !== false)}
                    data-testid="skill-enabled-toggle"
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                      selected.enabled !== false ? 'bg-primary' : 'bg-muted',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block size-3 transform rounded-full bg-background shadow transition-transform',
                        selected.enabled !== false ? 'translate-x-[18px]' : 'translate-x-[3px]',
                      )}
                    />
                  </button>
                </div>
              </div>

              {/* What this skill's own text cannot say: whether chat ever used
                  it, who wrote it, which behaviour it replaced, and what the
                  learning loop is waiting on. Hairlines, because this is
                  metadata rather than content. */}
              <div className="divide-y divide-border/60 border-y border-border/60" data-testid="skill-facts">
                <SkillFact label="Usage">{usageLine(selected)}</SkillFact>
                {liftFact && <SkillFact label="Measured effect">{liftFact}</SkillFact>}
                {selected.trigger && <SkillFact label="Trigger">{selected.trigger}</SkillFact>}
                {selected.origin && <SkillFact label="Source">{originLine(selected)}</SkillFact>}
                {superseded && (
                  <SkillFact label="Lineage">
                    Replaces{' '}
                    {superseded.row ? (
                      <button
                        type="button"
                        onClick={() => openDetail(superseded.name)}
                        className="font-medium text-primary hover:underline"
                      >
                        {superseded.name}
                      </button>
                    ) : (
                      <span className="font-medium text-foreground/85">{superseded.name}</span>
                    )}{' '}
                    {superseded.row
                      ? superseded.row.enabled === false
                        ? '— retired from injection when this version was approved.'
                        : '— still enabled, so both versions reach the model.'
                      : '— no longer in the catalogue.'}
                  </SkillFact>
                )}
                {openProposals.length > 0 && (
                  <SkillFact label="Learning">
                    {openProposals.length}{' '}
                    {openProposals.length === 1 ? 'proposal' : 'proposals'} awaiting your decision (
                    {openProposals.map((p) => p.kind).join(', ')}) —{' '}
                    <button
                      type="button"
                      data-testid="skill-open-inbox"
                      /* The inbox lives in BOTH hosts. A link that leaves
                         the surface has to land in the host the reader is
                         in — from the Learning hub, linking to the Settings
                         overlay threw the hub context away. */
                      onClick={() => void navigate(inboxRoute(host))}
                      className="font-medium text-primary hover:underline"
                    >
                      Review inbox
                    </button>
                  </SkillFact>
                )}
              </div>

              <section>
                <h3 className="mb-2 text-[0.65625rem] font-semibold uppercase tracking-widest text-muted-foreground/55">
                  Instructions
                </h3>
                <Markdown content={selected.instructions || '_No instructions body._'} demoteHeadings />
              </section>

              {/* Audit #13: what this file used to say. Read-only, and it is
                  scoped like every other read on this page — a project skill's
                  history is the project copy's, never the global one it
                  shadows. */}
              <SkillVersionsPanel name={selected.name} workspace={wsScope || undefined} />
            </div>
          )}
        </div>
      )}

      {/* ── Create / Edit form ──────────────────────────────────────── */}
      {isFormMode && (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="max-w-2xl space-y-4 rounded-xl border border-border/60 bg-card/60 p-5">
            {mode === 'create' && (
              <FormField
                label="Name"
                hint={
                  wsScope
                    ? 'Created in this project (`.aug/skills/`) — it shadows any same-named global skill here.'
                    : 'Lowercase, dotted/hyphenated. Max 64 chars.'
                }
              >
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="my-skill-name"
                  className="w-full rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
                />
              </FormField>
            )}
            <FormField label="Description" hint="What it does and when to use it — this is what makes the skill trigger, so name the situations and phrases a request would contain.">
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Use when…"
                className="w-full rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
              />
            </FormField>
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Trigger (optional)">
                <input
                  type="text"
                  value={form.trigger}
                  onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}
                  placeholder="e.g. fix performance issue"
                  className="w-full rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
                />
              </FormField>
              <FormField label="Category">
                <select
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm focus:border-primary/40 focus:outline-none [color-scheme:dark]"
                >
                  <option className="bg-card text-foreground" value="uncategorized">Uncategorized</option>
                  <option className="bg-card text-foreground" value="development">Development</option>
                  <option className="bg-card text-foreground" value="testing">Testing</option>
                  <option className="bg-card text-foreground" value="devops">DevOps</option>
                  <option className="bg-card text-foreground" value="writing">Writing</option>
                  <option className="bg-card text-foreground" value="research">Research</option>
                  <option className="bg-card text-foreground" value="learned">Learned</option>
                </select>
              </FormField>
            </div>
            <FormField
              label="Body (SKILL.md markdown)"
              hint={mode === 'edit' && wsScope ? 'Saving copy-on-writes this skill into the project scope if it is not a project skill yet.' : undefined}
            >
              <textarea
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                placeholder={'## When to Use\n\n## Procedure\n\n1. …'}
                rows={14}
                className="w-full resize-y rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
              />
            </FormField>
          </div>
        </div>
      )}

      {/* ── Delete confirm ──────────────────────────────────────────── */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50"
          role="presentation"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="mx-4 w-full max-w-sm space-y-4 rounded-xl border border-border/60 bg-card p-6"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-foreground">Delete skill?</h3>
            <p className="text-sm text-muted-foreground">
              {wsScope ? (
                <>
                  Delete <strong>{confirmDelete}</strong> from this project? The global skill it
                  shadows (if any) stays intact.
                </>
              ) : (
                <>
                  Delete <strong>{confirmDelete}</strong>? Bundled skills cannot be deleted.
                </>
              )}
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={saving}
                onClick={() => void handleDelete(confirmDelete)}
              >
                {saving ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Trigger hits, read from the per-skill usage sidecar. A zero count renders
 *  no line at all on purpose: most of a catalogue is never-triggered skills,
 *  so a "0 uses" note on every cell would state nothing and bury the facts
 *  that do carry information. It is metadata, not a badge — the reference's
 *  catalogue cells carry a muted line, not a chip. */
function UsageChip({ skill }: { skill: SkillSummary }) {
  const count = skill.usageCount ?? 0;
  if (!count) return null;
  const lastMs = skill.lastUsed ? Date.parse(skill.lastUsed) : NaN;
  return (
    <span
      className="text-2xs text-muted-foreground/70"
      data-testid="skill-usage-badge"
      title={
        Number.isFinite(lastMs)
          ? `used ${count}× — last ${new Date(lastMs).toLocaleString()}`
          : `used ${count}×`
      }
    >
      {count} use{count === 1 ? '' : 's'}
    </span>
  );
}

/** One label/value line of the detail pane's facts strip. */
function SkillFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-2">
      <span className="w-[52px] shrink-0 text-2xs font-semibold uppercase tracking-widest text-muted-foreground/55">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-[0.78125rem] leading-relaxed text-muted-foreground">
        {children}
      </span>
    </div>
  );
}

/** The counter the catalogue never answered: has this skill ever actually
 *  fired in a chat, and when. The sidecar writes an offset-bearing ISO
 *  timestamp, so `Date.parse` needs no normalizing here. */
function usageLine(skill: SkillSummary): string {
  const count = skill.usageCount ?? 0;
  if (!count) return 'No chat has triggered this skill yet.';
  const ms = skill.lastUsed ? Date.parse(skill.lastUsed) : NaN;
  return `Triggered ${count}× in chat${
    Number.isFinite(ms) ? `, most recently ${new Date(ms).toLocaleString()}` : ''
  }.`;
}

/** Provenance from an approved learning proposal. `version > 1` is the loop
 *  revising its own work, which is the thing worth saying out loud. */
function originLine(skill: SkillSummary): string {
  const by =
    skill.origin === 'distilled'
      ? 'August distilled this from its own sessions'
      : skill.origin === 'amended'
        ? 'August rewrote this from an approved proposal'
        : 'A human approved this wording';
  const v = (skill.version ?? 1) > 1 ? `, now at version ${skill.version}` : '';
  return `${by}${v}.`;
}

/** The scopes a skill can come from, in the order a reader reasons about
 *  them: what this project overrode, what lives in August's own folder, and
 *  what shipped with it. */
type SkillScopeKey = 'project' | 'agent' | 'bundled' | 'other';

const SKILL_SCOPE_GROUPS: Array<{ key: SkillScopeKey; label: string; note?: string }> = [
  {
    key: 'project',
    label: 'Project',
    note: 'This workspace’s own skills — they shadow a global one of the same name.',
  },
  {
    key: 'agent',
    label: 'Global',
    note: 'August’s own skills folder — written here from this page, or by a learning proposal you approved.',
  },
  { key: 'bundled', label: 'Bundled', note: 'Ship with August. Editing one saves a copy of its own, not the original.' },
  { key: 'other', label: 'Other' },
];

function skillScopeKey(s: SkillSummary): SkillScopeKey {
  if (s.scope === 'project') return 'project';
  if (s.scope === 'agent') return 'agent';
  if (s.scope === 'bundled') return 'bundled';
  // A bot-private root reports its own scope, and an older server reports
  // none. Only the second is guessable: fall back on the author, because
  // filing another agent's private skill under this one's would hide it.
  return s.scope
    ? 'other'
    : s.createdBy && s.createdBy !== 'builtin' && s.createdBy !== 'bundled'
      ? 'agent'
      : 'bundled';
}

/* One cell per skill in the 2-column grid: name, what it does, and the two
 * facts that say whether it is live and whether anyone uses it. The cell
 * opens the detail pane; the enable control is a REAL toggle that calls the
 * existing patch endpoint, not a status glyph — the whole point of a catalogue
 * is being able to curate it from the grid.
 *
 * The cell is BORDERLESS: the reference's catalogue grid is a two-column
 * grid of cells where "spacing does the work" (docs/plans/2026-10-11-ui-
 * reference-capture.md §2), and a border round every cell made a grid of
 * cards out of a list. The hover fill is what says "this is a cell".
 *
 * The enable control keeps visible "Disabled" text so the state is never
 * colour-only. The bulk checkbox stays a separate element outside the open
 * target so checking a box does not also navigate to the detail pane. */
function SkillCard({
  skill,
  onOpen,
  onToggleEnabled,
  selected = false,
  onToggleSelect,
}: {
  skill: SkillSummary;
  onOpen: () => void;
  onToggleEnabled: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const enabled = skill.enabled !== false;
  return (
    <div
      // The testid is on the OUTERMOST cell element so everything the row
      // says about a skill — name, state, usage — is inside it. Putting it
      // on the inner button leaves the usage footer a sibling, and
      // `within(row).getByTestId('skill-usage-badge')` then finds nothing
      // even though the badge is on screen.
      //
      // The cell itself is the open target, as the row was before: clicking
      // anywhere on it except the checkbox or the enable toggle opens detail.
      // Those two stopPropagation so a bulk check or a flip does not also
      // navigate away from the grid.
      data-testid={`skill-row-${skill.name}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // The checkbox and enable button are native keyboard controls nested
        // in the clickable cell. Let Space/Enter reach their own behavior;
        // only the cell itself treats those keys as "open details".
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-1 rounded-lg p-2.5 text-left transition hover:bg-muted/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        !enabled && 'bg-warning/[0.04]',
      )}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${skill.name}`}
          data-testid={`skill-select-${skill.name}`}
          className="mt-1 size-3 shrink-0 accent-[var(--dt-primary)]"
        />
        {/* The reference's catalogue cell opens with a rounded icon TILE.
            The Plugins tab's copy of this same grid still has it, so without
            the tile the two tabs' cells stop looking like the same thing. */}
        <span
          className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/60 text-primary"
          aria-hidden="true"
        >
          <Layers className="size-4" />
        </span>
        <div className="min-w-0 flex-1 text-left">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[0.8125rem] font-medium text-foreground/90">
              {skill.name}
            </span>
            {/* State and lineage as WORDS, not chips. The state is never
                carried by the icon alone — the amber "Disabled" word is
                still here, it just stopped being a badge. */}
            {!enabled && (
              <span className="shrink-0 text-2xs text-warning-fg" data-testid="skill-disabled-note">
                Disabled
              </span>
            )}
            {skill.overrides && (
              <span
                className="shrink-0 text-2xs text-muted-foreground/80"
                data-testid="skill-row-overrides"
              >
                overrides {skill.overrides}
              </span>
            )}
          </span>
          <span className="mt-0.5 line-clamp-1 block text-[0.71875rem] text-muted-foreground/75">
            {skill.description || 'No description'}
          </span>
        </div>
        {/* Icon-only, not a bordered "On" pill. The reference cell is a calm
            tile with a check at the right; twenty outlined buttons in a grid
            was the loudest thing on the page and said nothing. The CONTROL
            stays in both states — disabling from the grid is a real capability
            the tests guard — it just stops shouting when the skill is
            already on. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={(e) => {
            e.stopPropagation();
            onToggleEnabled();
          }}
          aria-pressed={!enabled}
          aria-label={`${enabled ? 'Disable' : 'Enable'} ${skill.name}`}
          data-testid={`skill-toggle-${skill.name}`}
          className={cn(
            'shrink-0',
            enabled
              ? 'text-muted-foreground/35 hover:text-muted-foreground'
              : 'text-warning-fg hover:bg-warning/10',
          )}
        >
          {enabled ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Power className="size-4" aria-hidden />
          )}
        </Button>
      </div>
      <div className="flex items-center gap-1.5 pl-5 text-2xs text-muted-foreground/60">
        {skill.createdBy && <span>{skill.createdBy}</span>}
        <UsageChip skill={skill} />
      </div>
    </div>
  );
}


function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
