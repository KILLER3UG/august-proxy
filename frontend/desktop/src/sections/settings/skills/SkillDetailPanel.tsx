/* Skill detail: back/edit/delete actions and SKILL.md rendered as Markdown. */

import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import type { SkillDetail } from './types';

export function SkillDetailPanel({
  selected,
  onBack,
  onEdit,
  onDelete,
}: {
  selected: SkillDetail;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto space-y-4 pb-8">
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.06] px-3 py-1.5 text-sm text-foreground hover:bg-white/[0.1]"
        >
          <ArrowLeft className="size-4" /> Back
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Pencil className="size-4" /> Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="size-4" /> Delete
        </button>
      </div>

      <div className="mx-auto max-w-3xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{selected.name}</h1>
          {selected.description && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {selected.description}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Category</span>
              <p className="font-medium text-foreground">{selected.category || '—'}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Source</span>
              <p className="font-medium text-foreground">{selected.createdBy || 'builtin'}</p>
            </div>
            <div className="col-span-2">
              <span className="text-muted-foreground">Trigger</span>
              <p className="font-medium text-foreground">{selected.trigger || '—'}</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-5">
          <h3 className="text-sm font-semibold mb-3 text-foreground">Instructions (SKILL.md)</h3>
          <div className="max-h-[min(32rem,55vh)] overflow-auto rounded-lg border border-white/[0.06] bg-black/20 px-4 py-3 markdown-content">
            {selected.instructions?.trim() ? (
              <Markdown content={selected.instructions} />
            ) : (
              <p className="text-sm text-muted-foreground">No instructions body.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
