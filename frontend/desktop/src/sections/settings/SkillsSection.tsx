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
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  FolderTree,
  Info,
  Loader2,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { QueryErrorState } from '@/components/QueryErrorState';
import { WorkspaceSelect } from '@/components/workspace/WorkspaceSelect';
import { LearningPanel } from '@/sections/settings/LearningPanel';
import { SkillPacksPanel } from '@/sections/settings/SkillPacksPanel';
import { Markdown } from '@/sections/chat/ChatMarkdown';
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

export function SkillsSection() {
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
  const grouped = useMemo(() => {
    const out: Record<SkillScopeKey, SkillSummary[]> = { project: [], agent: [], bundled: [], other: [] };
    for (const s of skills) out[skillScopeKey(s)].push(s);
    return out;
  }, [skills]);
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
      await api.delete(`/api/skills/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`);
      toast.success(`Skill '${name}' deleted${wsScope ? ' from this project' : ''}`);
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
      <header className="shrink-0 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          {(mode === 'detail' || isFormMode) && (
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
          )}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{headerLabel}</h1>
            {mode === 'list' && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {listFailed
                  ? "Couldn't load skills"
                  : `${skills.length} skill${skills.length === 1 ? '' : 's'} · loaded progressively into chat when relevant`}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {mode === 'list' && (
            <>
              <div className="relative w-56">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search…"
                  aria-label="Search skills"
                  className="h-8 w-full rounded-lg border border-border/60 bg-muted/40 pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
                />
              </div>
              <Button onClick={startCreate}>
                <Plus className="size-4" /> New
              </Button>
            </>
          )}
          {mode === 'detail' && selected && (
            <>
              <Button variant="outline" onClick={startEdit}>
                <Pencil className="size-3.5" /> Edit
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
                  <Trash2 className="size-3.5" /> Delete
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

      {/* ── C-1: scope selector ─────────────────────────────────────── */}
      {mode === 'list' && (
        <div className="flex shrink-0 items-center gap-2" data-testid="skills-scope-row">
          <FolderTree className="size-3.5 text-muted-foreground/70" />
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Scope</span>
          <div className="max-w-xs flex-1">
            <WorkspaceSelect
              value={wsScope}
              onChange={(e) => setWsScope(e.target.value)}
              options={scopeOptions}
              data-testid="skills-scope-select"
              aria-label="Skills scope"
            />
          </div>
          {wsScope && (
            <span className="text-[10.5px] text-muted-foreground/70">
              Project skills shadow same-named global ones
            </span>
          )}
        </div>
      )}

      {/* ── Skill packs: install-from-remote ───────────────────────── */}
      {mode === 'list' && <SkillPacksPanel />}

      {/* ── Part 16 Phase E: Learning (curator report + drafts) ─────── */}
      {mode === 'list' && <LearningPanel />}

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
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-card/40 px-6 py-12 text-center">
              <BookOpen className="mb-3 size-9 rounded-full bg-muted/50 p-1.5 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No skills yet</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                Click New to author your first skill.
              </p>
            </div>
          ) : (
            /* One hairline row per skill, grouped by the scope that decides
             * whether it shadows another — the card grid buried the only
             * distinction that matters when a catalogue grows. */
            <div className="space-y-4" data-testid="skill-rows">
              {SKILL_SCOPE_GROUPS.map(({ key, label, note }) => {
                const group = grouped[key];
                if (group.length === 0) return null;
                return (
                  <section key={key} data-testid={`skill-group-${key}`}>
                    <h3 className="flex items-baseline gap-2 pb-0.5 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground/55">
                      {label}
                      <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">
                        {group.length}
                      </span>
                    </h3>
                    {note && <p className="pb-1 text-[11px] text-muted-foreground/70">{note}</p>}
                    <div className="divide-y divide-white/[0.06]">
                      {group.map((s) => (
                        <SkillRow key={s.name} skill={s} onOpen={() => openDetail(s.name)} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
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
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold text-foreground">{selected.name}</span>
                    <span className="inline-flex cursor-default items-center gap-1 text-[11px] text-muted-foreground">
                      <Info className="size-3" />
                      {selected.createdBy ? `by ${selected.createdBy}` : 'bundled'}
                    </span>
                    <Badge variant="outline" className="text-[10px] capitalize">{selected.category}</Badge>
                    {/* C-2: scope + overrides badges */}
                    {selected.scope && (
                      <span
                        className={cn(
                          'rounded-md border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                          selected.scope === 'project'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                            : 'border-border/50 bg-muted/30 text-muted-foreground',
                        )}
                        data-testid="skill-scope-badge"
                      >
                        {selected.scope}
                      </span>
                    )}
                    {selected.overrides && (
                      <span
                        className="rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-400"
                        data-testid="skill-overrides-badge"
                      >
                        overrides {selected.overrides}
                      </span>
                    )}
                  </div>
                  <p className={cn('mt-1 text-[12.5px] leading-relaxed text-muted-foreground', !seeMore && 'line-clamp-2')}>
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
                      className="text-[11px] font-medium text-primary hover:underline"
                    >
                      See less
                    </button>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2 pt-1">
                  <span
                    className="text-[11px] text-muted-foreground"
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
                        'inline-block size-3.5 transform rounded-full bg-background shadow transition-transform',
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
              <div className="divide-y divide-white/[0.06] border-y border-white/[0.06]" data-testid="skill-facts">
                <SkillFact label="Usage">{usageLine(selected)}</SkillFact>
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
                      onClick={() => void navigate('/settings/harness-improve')}
                      className="font-medium text-primary hover:underline"
                    >
                      Review inbox
                    </button>
                  </SkillFact>
                )}
              </div>

              <section>
                <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground/55">
                  Instructions
                </h3>
                <Markdown content={selected.instructions || '_No instructions body._'} />
              </section>
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
            <FormField label="Description" hint="One sentence, ≤ 60 chars — this is what makes the skill trigger.">
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
 *  no chip on purpose: most of a catalogue is never-triggered skills, so a
 *  "0 uses" tag on every card would state nothing and bury the scope and
 *  overrides chips that do carry information. */
function UsageChip({ skill }: { skill: SkillSummary }) {
  const count = skill.usageCount ?? 0;
  if (!count) return null;
  const lastMs = skill.lastUsed ? Date.parse(skill.lastUsed) : NaN;
  return (
    <span
      className="rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
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
      <span className="w-[52px] shrink-0 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/55">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
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

/* One line per skill: name, what it does, and the two facts that say whether it
 * is live and whether anyone uses it. The whole row opens the detail pane. */
function SkillRow({ skill, onOpen }: { skill: SkillSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`skill-row-${skill.name}`}
      className="flex w-full items-center gap-3 py-2.5 text-left transition hover:bg-white/[0.03]"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground/90">{skill.name}</span>
          {skill.enabled === false && (
            <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[9px] uppercase tracking-wide text-amber-400">
              disabled
            </span>
          )}
          {skill.overrides && (
            <span
              className="shrink-0 rounded border border-sky-500/30 bg-sky-500/10 px-1 py-0.5 text-[9px] uppercase tracking-wide text-sky-400"
              data-testid="skill-row-overrides"
            >
              overrides {skill.overrides}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground/75">
          {skill.description || 'No description'}
        </span>
      </span>
      {skill.createdBy && (
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/50">
          {skill.createdBy}
        </span>
      )}
      <UsageChip skill={skill} />
    </button>
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
