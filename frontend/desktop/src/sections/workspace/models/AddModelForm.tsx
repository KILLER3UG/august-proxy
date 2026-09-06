/* Add-model modal — reference layout (Model ID / Context window / Max output
 * tokens / Input types / Output types, footer Cancel/Save). Creates a
 * manual-source model via providersApi.addModel. Advanced harness controls
 * (reasoning, wire format) live in the edit modal's Advanced section.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { providersApi } from '@/api/providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const MODALITIES = ['Text', 'Image', 'Video', 'PDF'] as const;

export function ModelModalField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

/** Pill-style checkbox used for Input/Output types (reference layout).
 *  Every modality — including Text — is toggleable. */
export function ModalityPills({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (m: string) => {
    onChange(value.includes(m) ? value.filter((x) => x !== m) : [...value, m]);
  };
  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-medium text-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {MODALITIES.map((m) => {
          const checked = value.includes(m);
          return (
            <button
              key={m}
              type="button"
              onClick={() => toggle(m)}
              aria-pressed={checked}
              className={
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] transition ' +
                (checked
                  ? 'border-primary/50 bg-primary/10 text-foreground'
                  : 'border-border/60 bg-card/60 text-muted-foreground hover:border-border hover:text-foreground')
              }
            >
              <span
                aria-hidden
                className={
                  'grid size-3.5 place-items-center rounded-sm border text-[9px] ' +
                  (checked
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-transparent')
                }
              >
                {checked ? '✓' : ''}
              </span>
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function AddModelForm({
  providerId,
  onCancel,
  onCreated,
}: {
  providerId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [id, setId] = useState('');
  const [contextWindow, setContextWindow] = useState('1000000');
  const [maxOutputTokens, setMaxOutputTokens] = useState('128000');
  const [inputTypes, setInputTypes] = useState<string[]>(['Text']);
  const [outputTypes, setOutputTypes] = useState<string[]>(['Text']);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const create = useMutation({
    mutationFn: () =>
      providersApi.addModel(providerId, {
        id,
        contextWindow: contextWindow ? Number(contextWindow) : 128000,
        maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : null,
        inputTypes: inputTypes.length ? inputTypes.map((t) => t.toLowerCase()) : null,
        outputTypes: outputTypes.length ? outputTypes.map((t) => t.toLowerCase()) : null,
      }),
    onSuccess: () => {
      toast.success(`Added ${id}`);
      onCreated();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Failed to add model');
    },
  });

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Add model"
      onClick={onCancel}
      data-testid="model-add-modal"
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-base font-semibold text-foreground">Add model</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3.5 px-5 py-4">
          <ModelModalField label="Model ID">
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="Model ID"
              className="h-9"
              autoFocus
            />
          </ModelModalField>
          <ModelModalField label="Context window">
            <Input
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
              placeholder="1000000"
              type="number"
              min={1}
              className="h-9"
            />
          </ModelModalField>
          <ModelModalField label="Max output tokens">
            <Input
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(e.target.value)}
              placeholder="128000"
              type="number"
              min={1}
              className="h-9"
            />
          </ModelModalField>
          <ModalityPills label="Input types" value={inputTypes} onChange={setInputTypes} />
          <ModalityPills label="Output types" value={outputTypes} onChange={setOutputTypes} />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3.5">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => create.mutate()} disabled={!id.trim() || create.isPending}>
            {create.isPending && <Loader2 className="mr-1.5 size-3 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
