/* ── Skills — Claude-style catalogue + detail viewer (0.17.0) ───────── */
/* List view: card grid (name, by-line, description, usage).            */
/* Detail view: name + attribution + enabled toggle + description with  */
/* see-more + SKILL.md rendered as markdown. Authoring via create/edit  */
/* forms and delete-with-confirm; bundled skills are copy-on-write.     */
/* Part 17 Phase C: workspace scope selector (project skills merge in   */
/* with shadowing, C-1), scope + overrides badges (C-2), and the write  */
/* paths (create/edit/delete/toggle) route through the selected scope.  */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { WorkspaceSelect } from '@/components/workspace/WorkspaceSelect';
import { LearningPanel } from '@/sections/settings/LearningPanel';
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
}

interface SkillDetail extends SkillSummary {
  instructions: string;
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
  const [mode, setMode] = useState<Mode>('list');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [search, setSearch] = useState('');
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
    queryKey: ['skills-list', search, wsScope],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set('q', search);
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

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['skills-list'] });
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
  const selected = detailQuery.data ?? null;
  const workspaces = workspacesQ.data?.workspaces ?? [];

  // Part 27 D4: disambiguate same-basename workspaces with their parent dir
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
                {skills.length} skill{skills.length === 1 ? '' : 's'} · loaded progressively into chat when relevant
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

      {/* ── Part 16 Phase E: Learning (curator report + drafts) ─────── */}
      {mode === 'list' && <LearningPanel />}

      {/* ── List ────────────────────────────────────────────────────── */}
      {mode === 'list' && (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="skills-grid">
          {listQuery.isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-card/40 px-6 py-12 text-center">
              <BookOpen className="mb-3 size-9 rounded-full bg-muted/50 p-1.5 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No skills yet</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                Click New to author your first skill.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {skills.map((s) => (
                <SkillCard key={s.name} skill={s} onOpen={() => openDetail(s.name)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Detail (Claude-style) ───────────────────────────────────── */}
      {mode === 'detail' && (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {detailQuery.isLoading || !selected ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
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

              {selected.trigger && (
                <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                  <span className="font-medium uppercase tracking-wide">Trigger · </span>
                  {selected.trigger}
                </div>
              )}

              <div className="rounded-xl border border-border/50 bg-card/60 p-5">
                <div className="mb-3 flex items-center gap-2">
                  <Badge variant="outline" className="font-mono text-[10px]">SKILL.md</Badge>
                </div>
                <Markdown content={selected.instructions || '_No instructions body._'} />
              </div>
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
                  className="w-full rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm focus:border-primary/40 focus:outline-none"
                >
                  <option value="uncategorized">Uncategorized</option>
                  <option value="development">Development</option>
                  <option value="testing">Testing</option>
                  <option value="devops">DevOps</option>
                  <option value="writing">Writing</option>
                  <option value="research">Research</option>
                  <option value="learned">Learned</option>
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

function SkillCard({ skill, onOpen }: { skill: SkillSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`skill-card-${skill.name}`}
      className="group w-full rounded-xl border border-border/50 bg-card/50 p-4 text-left transition hover:border-border hover:bg-card/80 focus:outline-none focus:ring-1 focus:ring-primary/40"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-[11px] font-semibold uppercase text-primary">
          {skill.name.slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-semibold text-foreground">{skill.name}</span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
            {skill.description || 'No description'}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            {skill.createdBy && (
              <span className="rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                {skill.createdBy}
              </span>
            )}
            {/* C-2: scope + overrides badges on cards. */}
            {skill.scope === 'project' && (
              <span
                className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-emerald-400"
                data-testid="skill-card-scope"
              >
                project
              </span>
            )}
            {skill.overrides && (
              <span
                className="rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-400"
                data-testid="skill-card-overrides"
              >
                overrides {skill.overrides}
              </span>
            )}
            {skill.enabled === false && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-400">
                disabled
              </span>
            )}
          </div>
        </div>
      </div>
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
