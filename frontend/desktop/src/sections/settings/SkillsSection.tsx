/* ── Skills — unified card catalog (3 columns) ───────────────────────── */
/* Same surface language as Integrations: big header, search, stat tiles,
 * responsive card grid (1 / 2 / 3 columns), detail drill-down.
 *
 *   • Stat tiles: Active / Stale / Archived / Tracked
 *   • Card grid from /api/skills + /api/curator/usage
 *   • Card click → detail (SKILL.md via chat Markdown)
 *   • + New → create form; Edit / Delete; pin / archive / restore
 *   • Lifecycle Run / Dry run */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, ArrowLeft } from 'lucide-react';
import { api } from '@/api/client';
import { SkillDetailPanel } from './skills/SkillDetailPanel';
import { SkillFormPanel } from './skills/SkillFormPanel';
import { SkillsDeleteDialog } from './skills/SkillsDeleteDialog';
import { SkillsListPanel } from './skills/SkillsListPanel';
import {
  EMPTY_SKILL_FORM,
  mergeSkillRows,
  type CuratorReport,
  type SkillDetail,
  type SkillFormState,
  type SkillSummary,
  type SkillUsage,
  type SkillsMode,
} from './skills/types';

export function SkillsSection() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [usage, setUsage] = useState<SkillUsage[]>([]);
  const [_total, _setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SkillsMode>('list');
  const [selected, setSelected] = useState<SkillDetail | null>(null);
  const [form, setForm] = useState<SkillFormState>(EMPTY_SKILL_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CuratorReport | null>(null);

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

  const reload = useCallback(
    async (q = '') => {
      await Promise.all([fetchSkills(q), fetchUsage()]);
    },
    [fetchSkills, fetchUsage],
  );

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  const rows = useMemo(() => mergeSkillRows(skills, usage), [skills, usage]);

  const activeCount = rows.filter((r) => r.state === 'active').length;
  const staleCount = rows.filter((r) => r.state === 'stale').length;
  const archivedCount = rows.filter((r) => r.state === 'archived').length;
  const trackedCount = rows.length;

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
    setForm(EMPTY_SKILL_FORM);
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
          name: form.name,
          description: form.description,
          body: form.body,
          trigger: form.trigger,
          category: form.category,
        });
      } else if (mode === 'edit' && form.name) {
        await api.patch(`/api/skills/${encodeURIComponent(form.name)}`, {
          body: form.body,
          description: form.description,
          trigger: form.trigger,
          category: form.category,
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
      if (selected?.name === name) {
        setSelected(null);
        setMode('list');
      }
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

  const handleRunCurator = async (dryRun = false) => {
    setRunning(true);
    setReport(null);
    try {
      const data = await api.post<{ report: CuratorReport }>(
        `/api/curator/run?dry_run=${dryRun}`,
      );
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

  if (loading) {
    return (
      <div className="px-8 py-6 space-y-6" data-testid="skills-skeleton">
        <div className="space-y-2">
          <div className="h-7 w-32 rounded-md bg-muted animate-pulse" />
          <div className="h-4 w-72 rounded-md bg-muted animate-pulse" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl border border-border/60 bg-muted/40 animate-pulse" />
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[100px] rounded-xl border border-border/60 bg-card animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const isFormMode = mode === 'create' || mode === 'edit';
  const filteredRows = search
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(search.toLowerCase()) ||
          r.description.toLowerCase().includes(search.toLowerCase()),
      )
    : rows;

  return (
    <div className="px-8 py-6 space-y-6 h-full flex flex-col overflow-hidden">
      {mode !== 'detail' && (
        <header className="shrink-0 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {mode === 'list'
                ? 'Skills'
                : isFormMode
                  ? mode === 'create'
                    ? 'Create skill'
                    : 'Edit skill'
                  : 'Skill'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === 'list'
                ? 'Create, edit, and manage your agent skills and their lifecycle.'
                : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isFormMode && (
              <button
                onClick={() => {
                  setMode('list');
                  setSelected(null);
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.06] px-3 py-1.5 text-sm text-foreground hover:bg-white/[0.1]"
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
          </div>
        </header>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      {mode === 'list' && (
        <SkillsListPanel
          filteredRows={filteredRows}
          search={search}
          skills={skills}
          activeCount={activeCount}
          staleCount={staleCount}
          archivedCount={archivedCount}
          trackedCount={trackedCount}
          running={running}
          report={report}
          onSearch={handleSearch}
          onOpen={(name) => void openSkill(name)}
          onTogglePin={(name, pinned) => void handleTogglePin(name, pinned)}
          onArchive={(name) => void handleArchive(name)}
          onRestore={(name) => void handleRestore(name)}
          onRunCurator={(dryRun) => void handleRunCurator(dryRun)}
          onInstalled={() => {
            void reload(search);
          }}
        />
      )}

      {mode === 'detail' && selected && (
        <SkillDetailPanel
          selected={selected}
          onBack={() => {
            setMode('list');
            setSelected(null);
          }}
          onEdit={startEdit}
          onDelete={() => setConfirmDelete(selected.name)}
        />
      )}

      {isFormMode && (
        <SkillFormPanel
          mode={mode}
          form={form}
          saving={saving}
          onChange={setForm}
          onSave={() => void handleSave()}
          onCancel={cancelForm}
        />
      )}

      {confirmDelete && (
        <SkillsDeleteDialog
          name={confirmDelete}
          saving={saving}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void handleDelete(confirmDelete)}
        />
      )}
    </div>
  );
}

export default SkillsSection;
