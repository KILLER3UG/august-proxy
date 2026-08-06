/* v4.1 — Model Fleet tab: maps the four cognitive roles (cortex /
   cerebellum / hippocampus / prefrontal) to models. Plainly edits the
   `auxiliary.model_fleet` slice of config.json via /api/config/model-fleet. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { WorkspaceField } from '@/components/workspace/WorkspaceField';
import { ModelPickerDropdown } from '@/components/overlays/ModelPickerDropdown';
import { PageLoader } from '@/components/PageLoader';
import {
  getModelFleet,
  updateModelFleet,
  getAggregatedModels,
  type ModelFleetConfig,
  type AggregatedModel,
} from '@/api/api-client';

const ROLE_META: Array<{
  key: keyof ModelFleetConfig;
  label: string;
  hint: string;
}> = [
  {
    key: 'cortex',
    label: 'Cortex model',
    hint: 'Main reasoning model for the conscious chat loop. Empty = use the session model.',
  },
  {
    key: 'cerebellum',
    label: 'Cerebellum model',
    hint: 'Fast, cheap model for background daemons and watchers.',
  },
  {
    key: 'hippocampus',
    label: 'Hippocampus model',
    hint: 'Model for memory consolidation and preference inference (sleep cycle, delta engine).',
  },
  {
    key: 'prefrontal',
    label: 'Prefrontal model',
    hint: 'Highest-reasoning model for skill genesis and /Exam authoring.',
  },
  {
    key: 'chat_default',
    label: 'Chat — default role',
    hint: 'Used for ordinary turns when routing is on. Empty = your selected model.',
  },
  {
    key: 'chat_smol',
    label: 'Chat — smol (subagents)',
    hint: 'Cheap model for sub-agent fan-out. Empty = the parent session model.',
  },
  {
    key: 'chat_slow',
    label: 'Chat — slow (deep reasoning)',
    hint: 'Used when effort is set to max. Empty = selected model.',
  },
  {
    key: 'chat_plan',
    label: 'Chat — plan mode',
    hint: 'Used for plan-mode turns. Empty = selected model.',
  },
  {
    key: 'chat_vision',
    label: 'Chat — vision',
    hint: 'Used when the turn has image attachments. Empty = selected model.',
  },
  {
    key: 'chat_chain',
    label: 'Chat — fallback chain',
    hint: 'Comma-separated model ids tried after the primary fails (429/5xx), in order.',
  },
  {
    key: 'chat_context_promotion',
    label: 'Chat — context promotion',
    hint: 'Larger-context sibling used when the primary hits a context overflow.',
  },
];

export function ModelFleetTab() {
  const qc = useQueryClient();

  const fleetQ = useQuery({
    queryKey: ['model-fleet-config'],
    queryFn: () => getModelFleet(),
  });
  const modelsQ = useQuery({
    queryKey: ['aggregated-models'],
    queryFn: () => getAggregatedModels(),
  });

  const fleet: ModelFleetConfig = fleetQ.data ?? {
    cortex: '',
    cerebellum: '',
    hippocampus: '',
    prefrontal: '',
    chat_default: '',
    chat_smol: '',
    chat_slow: '',
    chat_plan: '',
    chat_vision: '',
    chat_chain: '',
    chat_context_promotion: '',
  };
  const [editFleet, setEditFleet] = useState<ModelFleetConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const active = editFleet ?? fleet;
  const dirty =
    editFleet !== null && JSON.stringify(editFleet) !== JSON.stringify(fleet);

  // De-dupe model list (the aggregator can repeat ids across providers)
  const seen = new Set<string>();
  const models: AggregatedModel[] = (modelsQ.data?.models ?? []).filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  const handleSave = async () => {
    if (!editFleet) return;
    setSaving(true);
    try {
      await updateModelFleet(editFleet);
      setEditFleet(null);
      void qc.invalidateQueries({ queryKey: ['model-fleet-config'] });
      toast.success('Saved Model Fleet settings');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    const cleared: ModelFleetConfig = {
      cortex: '',
      cerebellum: '',
      hippocampus: '',
      prefrontal: '',
      chat_default: '',
      chat_smol: '',
      chat_slow: '',
      chat_plan: '',
      chat_vision: '',
      chat_chain: '',
      chat_context_promotion: '',
    };
    setEditFleet(cleared);
  };

  if (fleetQ.isLoading || modelsQ.isLoading) {
    return <PageLoader label="Loading model fleet…" variant="form" className="py-4 max-w-2xl" />;
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
        <div>
          <p className="text-sm font-semibold">Model Fleet</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Choose a model for each cognitive role. The Cortex is the main
            conscious loop; Cerebellum, Hippocampus, and Prefrontal serve
            the subconscious daemons, memory consolidation, and skill
            genesis respectively. Leaving a field empty falls back to the
            chat session's primary model.
          </p>
        </div>

        <div className="space-y-4">
          {ROLE_META.map(({ key, label, hint }) => (
            <div key={key} data-testid={`fleet-${key}-field`}>
              <WorkspaceField label={label} hint={hint}>
                {key === 'chat_chain' || key === 'chat_context_promotion' ? (
                  <div className="flex items-center gap-2">
                    <input
                      value={active[key] ?? ''}
                      onChange={(e) => setEditFleet({ ...active, [key]: e.target.value })}
                      placeholder={
                        key === 'chat_chain'
                          ? 'model-a, model-b, model-c'
                          : 'larger-context-model'
                      }
                      className="flex-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs font-mono"
                      data-testid={`fleet-${key}-input`}
                    />
                    <button
                      type="button"
                      onClick={() => setEditFleet({ ...active, [key]: '' })}
                      disabled={active[key] === '' || active[key] === undefined}
                      className="text-[11px] text-muted-foreground hover:text-foreground underline disabled:opacity-30 disabled:cursor-not-allowed"
                      data-testid={`fleet-${key}-clear`}
                    >
                      Clear
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <ModelPickerDropdown
                      models={models}
                      value={active[key] ?? ''}
                      onChange={(modelId) =>
                        setEditFleet({ ...active, [key]: modelId })
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setEditFleet({ ...active, [key]: '' })}
                      disabled={active[key] === '' || active[key] === undefined}
                      className="text-[11px] text-muted-foreground hover:text-foreground underline disabled:opacity-30 disabled:cursor-not-allowed"
                      data-testid={`fleet-${key}-clear`}
                    >
                      Clear (use session model)
                    </button>
                  </div>
                )}
              </WorkspaceField>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-white/[0.06]">
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-muted-foreground hover:text-foreground underline"
            data-testid="fleet-reset"
          >
            Reset to defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEditFleet(null)}
              disabled={!dirty}
              className="px-3 py-1.5 text-xs rounded border border-white/[0.06] hover:bg-white/[0.06] disabled:opacity-50"
              data-testid="fleet-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void handleSave(); }}
              disabled={!dirty || saving}
              className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
              data-testid="fleet-save"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
