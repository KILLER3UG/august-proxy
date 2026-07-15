/* Create / edit skill form: name, description, trigger, category, SKILL.md body. */

import { Save, X } from 'lucide-react';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { SKILL_CATEGORIES, type SkillFormState, type SkillsMode } from './types';

export function SkillFormPanel({
  mode,
  form,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  mode: SkillsMode;
  form: SkillFormState;
  saving: boolean;
  onChange: (next: SkillFormState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
        {mode === 'create' && (
          <div>
            <label className="text-sm font-medium mb-1 block">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => onChange({ ...form, name: e.target.value })}
              placeholder="my-skill-name"
              disabled={mode !== 'create'}
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-50 shadow-none"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Lowercase, dotted/hyphenated. Max 64 chars.
            </p>
          </div>
        )}
        <div>
          <label className="text-sm font-medium mb-1 block">Description</label>
          <input
            type="text"
            value={form.description}
            onChange={(e) => onChange({ ...form, description: e.target.value })}
            placeholder="One-sentence description, ≤ 60 chars"
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground shadow-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Trigger (optional)</label>
            <input
              type="text"
              value={form.trigger}
              onChange={(e) => onChange({ ...form, trigger: e.target.value })}
              placeholder="e.g. fix performance issue"
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground shadow-none"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block" htmlFor="skill-category">
              Category
            </label>
            <SettingsSelect
              id="skill-category"
              aria-label="Skill category"
              value={form.category || 'uncategorized'}
              onChange={(category) => onChange({ ...form, category })}
              options={[...SKILL_CATEGORIES]}
            />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">Body (SKILL.md markdown)</label>
          <textarea
            value={form.body}
            onChange={(e) => onChange({ ...form, body: e.target.value })}
            placeholder="## When to Use&#10;&#10;...&#10;&#10;## Procedure&#10;&#10;1. ..."
            rows={16}
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground resize-y shadow-none"
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving || !form.name || !form.description || !form.body}
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Save className="size-4" /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-card px-4 py-2 text-sm text-foreground hover:bg-card/80"
        >
          <X className="size-4" /> Cancel
        </button>
      </div>
    </div>
  );
}
