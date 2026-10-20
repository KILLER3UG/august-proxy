/* ── Prompt Templates settings section ─────────────────────────────── */
/* CRUD for user-defined prompt templates with variable support.        */

import { useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, Copy, X, Check } from 'lucide-react';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { SectionHeader } from '@/components/SectionHeader';
import { Button } from '@/components/ui/button';
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  extractVariables,
  type PromptTemplate,
} from '@/lib/prompt-templates';
import { toast } from 'sonner';

export function PromptTemplatesSection() {
  const { state: confirmState, confirm: confirmStyled, handleConfirm, handleCancel } =
    useConfirmDialog();
  const [templates, setTemplates] = useState<PromptTemplate[]>(() => listTemplates());
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [showForm, setShowForm] = useState(false);

  const variables = extractVariables(content);

  const refresh = useCallback(() => {
    setTemplates(listTemplates());
  }, []);

  const handleSave = useCallback(() => {
    if (!name.trim() || !content.trim()) {
      toast.error('Name and content are required');
      return;
    }
    if (editing) {
      updateTemplate(editing.id, { name, content });
      toast.success('Template updated');
    } else {
      createTemplate(name, content);
      toast.success('Template created');
    }
    setName('');
    setContent('');
    setEditing(null);
    setShowForm(false);
    refresh();
  }, [name, content, editing, refresh]);

  const handleEdit = useCallback((t: PromptTemplate) => {
    setEditing(t);
    setName(t.name);
    setContent(t.content);
    setShowForm(true);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const ok = await confirmStyled({
      title: 'Delete template?',
      message: 'Delete this template?',
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    deleteTemplate(id);
    refresh();
    toast.success('Template deleted');
  }, [refresh]);

  const handleCopy = useCallback((content: string) => {
    void navigator.clipboard.writeText(content);
    toast.success('Template copied to clipboard');
  }, []);

  return (
    <div className="space-y-6">
      {/* The standard panel header, and the ONE primary action in its
          actions slot — a filled button at the top right, the way the
          reference's catalogue puts it. */}
      <SectionHeader
        className="mb-0"
        title="Prompt Templates"
        subtitle={'Save reusable prompt templates. Use {{variableName}} for placeholders.'}
        actions={
          !showForm ? (
            <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4" />
              New template
            </Button>
          ) : null
        }
      />

      {/* Add / Edit form */}
      {showForm && (
        <div className="border border-border rounded-lg p-4 space-y-3 bg-muted/20">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              {editing ? 'Edit Template' : 'New Template'}
            </span>
            <button
              onClick={() => { setShowForm(false); setEditing(null); setName(''); setContent(''); }}
              className="p-1 rounded hover:bg-muted text-muted-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Template name"
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Template content. Use {{variable}} for placeholders."
            rows={6}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono resize-y"
          />
          {variables.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Variables: {variables.map(v => (
                <span key={v} className="inline-block px-1.5 py-0.5 bg-primary/10 text-primary rounded mx-0.5">
                  {'{{' + v + '}}'}
                </span>
              ))}
            </div>
          )}
          <button
            onClick={handleSave}
            disabled={!name.trim() || !content.trim()}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
          >
            <Check className="size-3" />
            {editing ? 'Update' : 'Create'}
          </button>
        </div>
      )}

      {/* Template list */}
      {templates.length === 0 && !showForm && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          No templates yet. Create one to get started.
        </div>
      )}

      {/* ONE container whose rows are hairline-separated. A list of bordered
          cards is the "N bordered cards" the reference rules out. It is not
          drawn when there is nothing in it — an empty container is a stray
          hairline, not a list. */}
      {templates.length > 0 && (
        <div className="divide-y divide-white/[0.04] overflow-hidden rounded-xl border border-white/[0.06] bg-card/60">
          {templates.map(t => (
            <div
              key={t.id}
              className="p-3 hover:bg-muted/30 transition group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-2 font-mono">
                    {t.content.slice(0, 120)}{t.content.length > 120 ? '…' : ''}
                  </div>
                  {t.variables.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {t.variables.map(v => (
                        <span key={v} className="text-2xs px-1 py-0.5 bg-muted rounded">
                          {'{{' + v + '}}'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
                  <button
                    onClick={() => handleCopy(t.content)}
                    className="p-1 rounded hover:bg-muted text-muted-foreground"
                    title="Copy template"
                  >
                    <Copy className="size-3" />
                  </button>
                  <button
                    onClick={() => handleEdit(t)}
                    className="p-1 rounded hover:bg-muted text-muted-foreground"
                    title="Edit template"
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    onClick={() => handleDelete(t.id)}
                    className="p-1 rounded hover:bg-muted text-destructive"
                    title="Delete template"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
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
    </div>
  );
}
