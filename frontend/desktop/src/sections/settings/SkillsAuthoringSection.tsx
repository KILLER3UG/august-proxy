/* ── Skills Authoring — create, edit, delete agent-authored skills ── */

import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Search,
  ArrowLeft,
  Save,
  X,
  FileUp,
  FileX,
  BookOpen,
} from 'lucide-react';
import { api } from '@/api/client';

interface SkillSummary {
  name: string;
  description: string;
  trigger: string;
  category: string;
  enabled: boolean;
  created_by: string;
}

interface SkillDetail extends SkillSummary {
  instructions: string;
}

type Mode = 'list' | 'create' | 'edit' | 'detail';

const EMPTY_FORM = { name: '', description: '', body: '', trigger: '', category: 'uncategorized' };

export function SkillsAuthoringSection() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('list');
  const [selected, setSelected] = useState<SkillDetail | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const fetchSkills = useCallback(async (q = '') => {
    try {
      const path = q ? `/api/skills?q=${encodeURIComponent(q)}` : '/api/skills';
      const data = await api.get<{ skills: SkillSummary[]; total: number }>(path);
      setSkills(data.skills ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load skills');
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchSkills()]).finally(() => setLoading(false));
  }, [fetchSkills]);

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
      await fetchSkills(search);
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
      await fetchSkills(search);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete skill');
    } finally {
      setSaving(false);
    }
  };

  const handleSearch = (q: string) => {
    setSearch(q);
    fetchSkills(q);
  };

  // ── Render ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <BookOpen className="size-8 animate-pulse text-muted-foreground" />
      </div>
    );
  }

  const isFormMode = mode === 'create' || mode === 'edit';

  return (
    <div className="px-8 py-6 space-y-6 h-full flex flex-col overflow-auto">
      <header className="shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {mode === 'list' ? 'Skills' : isFormMode ? (mode === 'create' ? 'Create Skill' : 'Edit Skill') : selected?.name ?? 'Skill'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === 'list' ? `${total} skill(s) — create and manage agent-authored skills.` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(isFormMode || mode === 'detail') && (
            <button onClick={() => { setMode('list'); setSelected(null); }}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-card px-3 py-1.5 text-sm text-foreground hover:bg-card/80">
              <ArrowLeft className="size-4" /> Back
            </button>
          )}
          {mode === 'list' && (
            <button onClick={startCreate}
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              <Plus className="size-4" /> Create
            </button>
          )}
          {mode === 'detail' && (
            <>
              <button onClick={startEdit}
                className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                <Pencil className="size-4" /> Edit
              </button>
              <button onClick={() => setConfirmDelete(selected!.name)}
                className="inline-flex items-center gap-1 rounded-lg border border-destructive/50 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10">
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

      {/* ── List view ──────────────────────────────────────────────── */}
      {mode === 'list' && (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type="text" placeholder="Search skills..."
              value={search} onChange={e => handleSearch(e.target.value)}
              className="w-full rounded-lg border border-white/[0.06] bg-card/60 pl-10 pr-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-card/60 overflow-hidden">
            <div className="overflow-auto max-h-[500px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card/95">
                  <tr className="border-b border-white/[0.06] text-left text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Name</th>
                    <th className="px-5 py-2 font-medium">Description</th>
                    <th className="px-5 py-2 font-medium">Category</th>
                    <th className="px-5 py-2 font-medium">Source</th>
                    <th className="px-5 py-2 font-medium">Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {skills.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-center text-muted-foreground">
                        {search ? 'No skills match your search.' : 'No skills yet. Click Create to add one.'}
                      </td>
                    </tr>
                  ) : (
                    skills.map(s => (
                      <tr key={s.name} className="border-b border-white/[0.06] hover:bg-white/[0.02] cursor-pointer"
                          onClick={() => openSkill(s.name)}>
                        <td className="px-5 py-3 font-medium">{s.name}</td>
                        <td className="px-5 py-3 text-muted-foreground max-w-xs truncate">{s.description}</td>
                        <td className="px-5 py-3"><span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs">{s.category}</span></td>
                        <td className="px-5 py-3 text-muted-foreground">{s.created_by || 'builtin'}</td>
                        <td className="px-5 py-3">{s.enabled ? '✅' : '❌'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Detail view ────────────────────────────────────────────── */}
      {mode === 'detail' && selected && (
        <div className="space-y-4">
          <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><span className="text-muted-foreground">Name:</span> <span className="font-medium">{selected.name}</span></div>
              <div><span className="text-muted-foreground">Category:</span> <span>{selected.category}</span></div>
              <div><span className="text-muted-foreground">Trigger:</span> <span>{selected.trigger || '—'}</span></div>
              <div><span className="text-muted-foreground">Source:</span> <span>{selected.created_by || 'builtin'}</span></div>
            </div>
            <div className="text-sm">
              <span className="text-muted-foreground">Description:</span>
              <p className="mt-1">{selected.description}</p>
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5">
            <h3 className="text-sm font-semibold mb-3">Instructions (SKILL.md body)</h3>
            <pre className="whitespace-pre-wrap text-sm text-muted-foreground font-mono leading-relaxed max-h-96 overflow-auto">
              {selected.instructions}
            </pre>
          </div>
        </div>
      )}

      {/* ── Create / Edit form ─────────────────────────────────────── */}
      {isFormMode && (
        <div className="space-y-4 max-w-2xl">
          <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
            {mode === 'create' && (
              <div>
                <label className="text-sm font-medium mb-1 block">Name</label>
                <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="my-skill-name" disabled={mode !== 'create'}
                  className="w-full rounded-lg border border-white/[0.06] bg-background px-3 py-2 text-sm disabled:opacity-50" />
                <p className="text-xs text-muted-foreground mt-1">Lowercase, dotted/hyphenated. Max 64 chars.</p>
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-1 block">Description</label>
              <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="One-sentence description, ≤ 60 chars"
                className="w-full rounded-lg border border-white/[0.06] bg-background px-3 py-2 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Trigger (optional)</label>
                <input type="text" value={form.trigger} onChange={e => setForm(f => ({ ...f, trigger: e.target.value }))}
                  placeholder="e.g. fix performance issue"
                  className="w-full rounded-lg border border-white/[0.06] bg-background px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Category</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full rounded-lg border border-white/[0.06] bg-background px-3 py-2 text-sm">
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
              <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                placeholder="## When to Use&#10;&#10;...&#10;&#10;## Procedure&#10;&#10;1. ..."
                rows={16}
                className="w-full rounded-lg border border-white/[0.06] bg-background px-3 py-2 text-sm font-mono resize-y" />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={handleSave} disabled={saving || !form.name || !form.description || !form.body}
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              <Save className="size-4" /> {saving ? 'Saving...' : 'Save'}
            </button>
            <button onClick={cancelForm}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-card px-4 py-2 text-sm text-foreground hover:bg-card/80">
              <X className="size-4" /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Delete confirmation ────────────────────────────────────── */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConfirmDelete(null)}>
          <div className="rounded-xl border border-white/[0.06] bg-card p-6 max-w-sm w-full mx-4 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold">Delete skill?</h3>
            <p className="text-sm text-muted-foreground">Are you sure you want to delete <strong>{confirmDelete}</strong>? This action cannot be undone for agent-authored skills. Bundled skills cannot be deleted.</p>
            <div className="flex items-center justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)}
                className="rounded-lg border border-white/[0.06] bg-card px-4 py-2 text-sm hover:bg-card/80">Cancel</button>
              <button onClick={() => handleDelete(confirmDelete)} disabled={saving}
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
                {saving ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
