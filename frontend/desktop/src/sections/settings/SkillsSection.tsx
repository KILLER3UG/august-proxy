/* ── Skills — unified, modern, beginner-friendly settings surface ──────── */
/* Merges the previous "Skill Authoring" (CRUD on /api/skills) and "Skill
 * Catalogue" (lifecycle on /api/curator) sections into a single calm
 * screen. Preserves every previous feature:
 *
 *   • Stat tiles: Active / Stale / Archived / Tracked
 *   • Run Now / Dry Run curator actions + report banner
 *   • Unified skill table merged from /api/skills + /api/curator/usage
 *   • Row-click → detail view (SKILL.md body + metadata)
 *   • + New → create form (Name / Description / Trigger / Category / Body)
 *   • Edit / Delete with confirmation modal (authoring)
 *   • Pin / Unpin / Archive / Restore row actions (curator)
 *
 * Layout language: generous whitespace, hairline borders, one primary
 * action, row-hover-revealed icon controls. */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Search,
  ArrowLeft,
  Save,
  X,
  BookOpen,
  RefreshCw,
  Archive,
  RotateCcw,
  Clock,
  Pin,
  PinOff,
  CheckCircle,
  Info,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { api } from '@/api/client';

/* ── Types ──────────────────────────────────────────────────────────── */

interface SkillSummary {
  name: string;
  description: string;
  trigger: string;
  category: string;
  enabled: boolean;
  createdBy: string;
}

interface SkillDetail extends SkillSummary {
  instructions: string;
}

interface SkillUsage {
  name: string;
  useCount: number;
  viewCount: number;
  patchCount: number;
  lastUsedAt: number | null;
  state: string;
  pinned: boolean;
  archivedAt: number | null;
}

interface CuratorReport {
  active: number;
  staled: string[];
  archived: string[];
  errors: string[];
}

/** One row in the unified table. */
interface SkillRow {
  name: string;
  description: string;
  category: string;
  source: string;
  enabled: boolean;
  state: string;
  pinned: boolean;
  useCount: number;
  viewCount: number;
  patchCount: number;
  lastUsedAt: number | null;
}

type Mode = 'list' | 'create' | 'edit' | 'detail';

const EMPTY_FORM = { name: '', description: '', body: '', trigger: '', category: 'uncategorized' };

/* ── Component ──────────────────────────────────────────────────────── */

export function SkillsSection() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [usage, setUsage] = useState<SkillUsage[]>([]);
  const [_total, _setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('list');
  const [selected, setSelected] = useState<SkillDetail | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CuratorReport | null>(null);

  /* ── Data loading ─────────────────────────────────────────────── */

  const fetchSkills = useCallback(async (q = '') => {
    try {
      const path = q ? `/api/skills?q=${encodeURIComponent(q)}` : '/api/skills';
      const data = await api.get<{ skills: SkillSummary[]; total: number }>(path);
      setSkills(data.skills ?? []);
      _setTotal(data.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load skills');
    }
  }, []);

  const fetchUsage = useCallback(async () => {
    try {
      const data = await api.get<{ usage: SkillUsage[] }>('/api/curator/usage');
      setUsage(data.usage ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage');
    }
  }, []);

  const reload = useCallback(async (q = '') => {
    await Promise.all([fetchSkills(q), fetchUsage()]);
  }, [fetchSkills, fetchUsage]);

  useEffect(() => {
	    void reload().finally(() => setLoading(false));
  }, [reload]);

  /* ── Merged table rows ────────────────────────────────────────── */

  const rows = useMemo<SkillRow[]>(() => {
    const byName = new Map<string, SkillRow>();
    for (const s of skills) {
      byName.set(s.name, {
        name: s.name,
        description: s.description,
        category: s.category,
        source: s.createdBy || 'builtin',
        enabled: s.enabled,
        state: 'active',
        pinned: false,
        useCount: 0,
        viewCount: 0,
        patchCount: 0,
        lastUsedAt: null,
      });
    }
    for (const u of usage) {
      const existing = byName.get(u.name);
      if (existing) {
        existing.state = u.state;
        existing.pinned = u.pinned;
        existing.useCount = u.useCount;
        existing.viewCount = u.viewCount;
        existing.patchCount = u.patchCount;
        existing.lastUsedAt = u.lastUsedAt;
      } else {
        byName.set(u.name, {
          name: u.name,
          description: '',
          category: '',
          source: 'agent',
          enabled: true,
          state: u.state,
          pinned: u.pinned,
          useCount: u.useCount,
          viewCount: u.viewCount,
          patchCount: u.patchCount,
          lastUsedAt: u.lastUsedAt,
        });
      }
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [skills, usage]);

  const activeCount = rows.filter((r) => r.state === 'active').length;
  const staleCount = rows.filter((r) => r.state === 'stale').length;
  const archivedCount = rows.filter((r) => r.state === 'archived').length;
  const trackedCount = rows.length;

  /* ── Authoring actions ────────────────────────────────────────── */

  const openSkill = async (name: string) => {
    try {
      const detail = await api.get<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`);
      setSelected(detail);
      setForm({
        name: detail.name,
        description: detail.description,
        body: detail.instructions,
        trigger: detail.trigger,
        category: detail.category,
      });
      setMode('detail');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load skill');
    }
  };

  const startCreate = () => {
    setSelected(null);
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
      category: selected.category,
    });
    setMode('edit');
  };

  const cancelForm = () => {
    if (selected) {
      setMode('detail');
      setForm({
        name: selected.name,
        description: selected.description,
        body: selected.instructions,
        trigger: selected.trigger,
        category: selected.category,
      });
    } else {
      setMode('list');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (mode === 'create') {
        await api.post('/api/skills', {
          name: form.name, description: form.description,
          body: form.body, trigger: form.trigger, category: form.category,
        });
      } else if (mode === 'edit' && form.name) {
        await api.patch(`/api/skills/${encodeURIComponent(form.name)}`, {
          body: form.body, description: form.description,
          trigger: form.trigger, category: form.category,
        });
      }
      await reload(search);
      setMode('list');
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    setSaving(true);
    setError(null);
    try {
      await api.delete(`/api/skills/${encodeURIComponent(name)}`);
      setConfirmDelete(null);
      if (selected?.name === name) { setSelected(null); setMode('list'); }
      await reload(search);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete skill');
    } finally {
      setSaving(false);
    }
  };

  const handleSearch = (q: string) => {
    setSearch(q);
	    void fetchSkills(q);
  };

  /* ── Curator actions ──────────────────────────────────────────── */

  const handleRunCurator = async (dryRun = false) => {
    setRunning(true);
    setReport(null);
    try {
      const data = await api.post<{ report: CuratorReport }>(`/api/curator/run?dry_run=${dryRun}`);
      setReport(data.report);
      await fetchUsage();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run curator');
    } finally {
      setRunning(false);
    }
  };

  const handleTogglePin = async (name: string, pinned: boolean) => {
    try {
      if (pinned) {
        await api.post(`/api/curator/unpin/${encodeURIComponent(name)}`);
      } else {
        await api.post(`/api/curator/pin/${encodeURIComponent(name)}`);
      }
      await fetchUsage();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle pin');
    }
  };

  const handleArchive = async (name: string) => {
    try {
      await api.post(`/api/curator/archive/${encodeURIComponent(name)}`);
      await fetchUsage();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to archive');
    }
  };

  const handleRestore = async (name: string) => {
    try {
      await api.post(`/api/curator/restore/${encodeURIComponent(name)}`);
      await fetchUsage();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to restore');
    }
  };

  /* ── Render ───────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <BookOpen className="size-8 animate-pulse text-muted-foreground" />
      </div>
    );
  }

  const isFormMode = mode === 'create' || mode === 'edit';

  return (
    <div className="px-10 py-8 space-y-8 h-full flex flex-col overflow-auto">
      {/* ── Header ──────────────────────────────────────────────── */}
      <header className="shrink-0 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {mode === 'list' ? 'Skills'
              : isFormMode ? (mode === 'create' ? 'Create skill' : 'Edit skill')
              : selected?.name ?? 'Skill'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === 'list'
              ? 'Create, edit, and manage your agent skills and their lifecycle.'
              : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(isFormMode || mode === 'detail') && (
            <button
              onClick={() => { setMode('list'); setSelected(null); }}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-card px-3 py-1.5 text-sm text-foreground hover:bg-card/80"
            >
              <ArrowLeft className="size-4" /> Back
            </button>
          )}
          {mode === 'list' && (
            <button
              onClick={startCreate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="size-4" /> New
            </button>
          )}
          {mode === 'detail' && (
            <>
              <button
                onClick={startEdit}
                className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Pencil className="size-4" /> Edit
              </button>
              <button
                onClick={() => setConfirmDelete(selected!.name)}
                className="inline-flex items-center gap-1 rounded-lg border border-destructive/50 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="size-4" /> Delete
              </button>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {report && mode === 'list' && (
        <div className="rounded-lg border border-white/[0.06] bg-card/60 p-4 text-sm space-y-1">
          <p className="font-medium">Curation run complete</p>
          <p className="text-muted-foreground">
            {report.staled.length > 0 ? `Staled: ${report.staled.join(', ')}. ` : 'No skills staled. '}
            {report.archived.length > 0 ? `Archived: ${report.archived.join(', ')}. ` : 'No skills archived. '}
            {report.errors.length > 0 && `Errors: ${report.errors.join(', ')}.`}
          </p>
        </div>
      )}

      {/* ── List view ──────────────────────────────────────────── */}
      {mode === 'list' && (
        <>
          {/* Stat tiles */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile icon={<CheckCircle className="size-4" />} label="Active" value={activeCount} />
            <StatTile icon={<Clock className="size-4" />} label="Stale" value={staleCount} tone={staleCount > 0 ? 'warn' : 'muted'} />
            <StatTile icon={<Archive className="size-4" />} label="Archived" value={archivedCount} />
            <StatTile icon={<BookOpen className="size-4" />} label="Tracked" value={trackedCount} />
          </div>

          {/* Search */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search skills…"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="w-full rounded-lg border border-white/[0.06] bg-card/60 pl-10 pr-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Unified table */}
          <div className="rounded-xl border border-white/[0.06] bg-card/60 overflow-hidden">
            <div className="overflow-auto max-h-[420px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card/95">
                  <tr className="border-b border-white/[0.06] text-left text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Name</th>
                    <th className="px-5 py-2 font-medium">State</th>
                    <th className="px-5 py-2 font-medium">Source</th>
                    <th className="px-5 py-2 font-medium">Uses</th>
                    <th className="px-5 py-2 font-medium">Last used</th>
                    <th className="px-5 py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-5 py-10 text-center text-muted-foreground">
                        {search ? 'No skills match your search.' : 'No skills yet. Click New to add one.'}
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr
                        key={r.name}
                        className="group border-b border-white/[0.06] hover:bg-white/[0.02] cursor-pointer"
                        onClick={() => void openSkill(r.name)}
                      >
                        <td className="px-5 py-3 font-medium">{r.name}</td>
                        <td className="px-5 py-3"><StateBadge state={r.state} /></td>
                        <td className="px-5 py-3 text-muted-foreground">{r.source}</td>
                        <td className="px-5 py-3 text-muted-foreground">{r.useCount}</td>
                        <td className="px-5 py-3 text-muted-foreground">
                          {r.lastUsedAt ? new Date(r.lastUsedAt * 1000).toLocaleDateString() : '—'}
                        </td>
                        <td className="px-5 py-3">
                          <div
                            className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <RowIconButton
                              title={r.pinned ? 'Unpin' : 'Pin'}
                              onClick={() => void handleTogglePin(r.name, r.pinned)}
                            >
                              {r.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                            </RowIconButton>
                            <RowIconButton
                              title="Archive"
                              onClick={() => void handleArchive(r.name)}
                              disabled={r.state === 'archived'}
                            >
                              <Archive className="size-4" />
                            </RowIconButton>
                            <RowIconButton
                              title="Restore"
                              onClick={() => void handleRestore(r.name)}
                              disabled={r.state !== 'archived'}
                            >
                              <RotateCcw className="size-4" />
                            </RowIconButton>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Lifecycle row */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/[0.06] bg-card/40 px-5 py-4">
            <div className="flex items-start gap-3">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Lifecycle</p>
                <p>Skills auto-archive after 60 days of no use. Pin to keep.</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleRunCurator(false)}
                disabled={running}
                className="inline-flex items-center gap-2 rounded-lg border border-white/[0.06] bg-card px-3 py-1.5 text-sm text-foreground hover:bg-card/80 disabled:opacity-50"
              >
                <RefreshCw className={`size-4 ${running ? 'animate-spin' : ''}`} />
                Run
              </button>
              <button
                onClick={() => void handleRunCurator(true)}
                disabled={running}
                className="inline-flex items-center gap-2 rounded-lg border border-white/[0.06] bg-card px-3 py-1.5 text-sm text-foreground hover:bg-card/80 disabled:opacity-50"
              >
                Dry run
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Detail view ────────────────────────────────────────── */}
      {mode === 'detail' && selected && (
        <div className="space-y-4 max-w-3xl">
          <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><span className="text-muted-foreground">Name:</span> <span className="font-medium">{selected.name}</span></div>
              <div><span className="text-muted-foreground">Category:</span> <span>{selected.category}</span></div>
              <div><span className="text-muted-foreground">Trigger:</span> <span>{selected.trigger || '—'}</span></div>
              <div><span className="text-muted-foreground">Source:</span> <span>{selected.createdBy || 'builtin'}</span></div>
            </div>
            <div className="text-sm">
              <span className="text-muted-foreground">Description:</span>
              <p className="mt-1">{selected.description}</p>
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5">
            <h3 className="text-sm font-semibold mb-3">Instructions (SKILL.md body)</h3>
            <pre className="whitespace-pre-wrap text-sm text-muted-foreground font-mono leading-relaxed max-h-[28rem] overflow-auto">
              {selected.instructions}
            </pre>
          </div>
        </div>
      )}

      {/* ── Create / Edit form ─────────────────────────────────── */}
      {isFormMode && (
        <div className="space-y-4 max-w-2xl">
          <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
            {mode === 'create' && (
              <div>
                <label className="text-sm font-medium mb-1 block">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="my-skill-name"
                  disabled={mode !== 'create'}
                  className="w-full rounded-lg border border-white/[0.06] bg-background px-3 py-2 text-sm disabled:opacity-50"
                />
                <p className="text-xs text-muted-foreground mt-1">Lowercase, dotted/hyphenated. Max 64 chars.</p>
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-1 block">Description</label>
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="One-sentence description, ≤ 60 chars"
                className="w-full rounded-lg border border-white/[0.06] bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Trigger (optional)</label>
                <input
                  type="text"
                  value={form.trigger}
                  onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}
                  placeholder="e.g. fix performance issue"
                  className="w-full rounded-lg border border-white/[0.06] bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Category</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  className="w-full rounded-lg border border-white/[0.06] bg-background px-3 py-2 text-sm"
                >
                  <option value="uncategorized">Uncategorized</option>
                  <option value="development">Development</option>
                  <option value="testing">Testing</option>
                  <option value="devops">DevOps</option>
                  <option value="writing">Writing</option>
                  <option value="research">Research</option>
                  <option value="learned">Learned</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Body (SKILL.md markdown)</label>
              <textarea
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                placeholder="## When to Use&#10;&#10;...&#10;&#10;## Procedure&#10;&#10;1. ..."
                rows={16}
                className="w-full rounded-lg border border-white/[0.06] bg-background px-3 py-2 text-sm font-mono resize-y"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => void handleSave()}
              disabled={saving || !form.name || !form.description || !form.body}
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Save className="size-4" /> {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={cancelForm}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-card px-4 py-2 text-sm text-foreground hover:bg-card/80"
            >
              <X className="size-4" /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Delete confirmation ────────────────────────────────── */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="rounded-xl border border-white/[0.06] bg-card p-6 max-w-sm w-full mx-4 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold">Delete skill?</h3>
            <p className="text-sm text-muted-foreground">
              Are you sure you want to delete <strong>{confirmDelete}</strong>? This action cannot be
              undone for agent-authored skills. Bundled skills cannot be deleted.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="rounded-lg border border-white/[0.06] bg-card px-4 py-2 text-sm hover:bg-card/80"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDelete(confirmDelete)}
                disabled={saving}
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {saving ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────── */

function StatTile({ icon, label, value, tone = 'muted' }: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: 'warn' | 'muted';
}) {
  const valueClass = tone === 'warn' && value > 0 ? 'text-warning' : 'text-foreground';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
      <div className="flex items-center gap-2 mb-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className={`text-2xl font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const config: Record<string, { label: string; className: string }> = {
    active: { label: 'Active', className: 'bg-success/20 text-success' },
    stale: { label: 'Stale', className: 'bg-warning/20 text-warning' },
    archived: { label: 'Archived', className: 'bg-muted text-muted-foreground' },
  };
  const c = config[state] ?? { label: state, className: 'bg-muted text-muted-foreground' };
  return <Badge variant="outline" className={c.className}>{c.label}</Badge>;
}

function RowIconButton({
  children, onClick, title, disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition"
    >
      {children}
    </button>
  );
}