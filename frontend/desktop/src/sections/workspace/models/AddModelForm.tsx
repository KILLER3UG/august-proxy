/* Manual model entry form for a provider's model list.
 * Creates a manual-source model via providersApi.addModel with optional
 * display name, context window, and reasoning flag.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { providersApi } from '@/api/providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
  const [name, setName] = useState('');
  const [contextWindow, setContextWindow] = useState('128000');
  const [reasoning, setReasoning] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      providersApi.addModel(providerId, {
        id,
        name: name || undefined,
        contextWindow: contextWindow ? Number(contextWindow) : 128000,
        reasoning,
      }),
    onSuccess: () => {
      toast.success(`Added ${id}`);
      onCreated();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Failed to add model');
    },
  });

  return (
    <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
      <div className="grid grid-cols-[1fr_1fr_140px] gap-2">
        <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="model-id" />
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name (optional)" />
        <Input
          value={contextWindow}
          onChange={(e) => setContextWindow(e.target.value)}
          placeholder="Context window"
          type="number"
          min={1}
          aria-label="Context window"
        />
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
        Supports reasoning
      </label>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => create.mutate()} disabled={!id.trim() || create.isPending}>
          {create.isPending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
