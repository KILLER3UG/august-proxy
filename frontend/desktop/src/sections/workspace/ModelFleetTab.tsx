/* v4.1 — Model Fleet tab: maps the cognitive + chat routing roles to models.
   Edits the `auxiliary.cognitive.fleet` / `fleetProviders` slices of config.json
   through /api/config/model-fleet.

   The ROLE LIST is not declared here: it comes from the server's `models` map,
   because a role the UI offers and the service does not know 400s the whole
   patch — five fields here used to be exactly that, and saving any of them
   silently discarded the other six too. `ROLE_COPY` holds only the prose, and a
   role with no entry renders under its own key rather than disappearing. */
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
  type ModelFleetRole,
  type ModelFleetState,
  type AggregatedModel,
} from '@/api/api-client';

const ROLE_COPY: Partial<Record<ModelFleetRole, { label: string; hint: string }>> = {
  cortex: {
    label: 'Cortex model',
    hint: 'Main reasoning model for the conscious chat loop. Empty = use the session model.',
  },
  cerebellum: {
    label: 'Cerebellum model',
    hint: 'Fast, cheap model for background daemons and watchers.',
  },
  hippocampus: {
    label: 'Hippocampus model',
    hint: 'Model for memory consolidation and preference inference (sleep cycle, delta engine).',
  },
  prefrontal: {
    label: 'Prefrontal model',
    hint: 'Highest-reasoning model for skill genesis and /Exam authoring.',
  },
  chat_default: {
    label: 'Chat — default role',
    hint: 'Used for ordinary turns when routing is on. Empty = your selected model.',
  },
  chat_smol: {
    label: 'Chat — smol (subagents)',
    hint: 'Cheap model for sub-agent fan-out. Empty = the parent session model.',
  },
  chat_slow: {
    label: 'Chat — slow (deep reasoning)',
    hint: 'Used when effort is set to max. Empty = selected model.',
  },
  chat_plan: {
    label: 'Chat — plan mode',
    hint: 'Used for plan-mode turns. Empty = selected model.',
  },
  chat_vision: {
    label: 'Chat — vision',
    hint: 'Used when the turn has image attachments. Empty = selected model.',
  },
  chat_chain: {
    label: 'Chat — fallback chain',
    hint: 'Comma-separated model ids tried after the primary fails (429/5xx), in order.',
  },
  chat_context_promotion: {
    label: 'Chat — context promotion',
    hint: 'Larger-context sibling used when the primary hits a context overflow.',
  },
};

const EMPTY_STATE: ModelFleetState = { models: {}, providers: {} };

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

  const fleet = fleetQ.data ?? EMPTY_STATE;
  const [editFleet, setEditFleet] = useState<ModelFleetState | null>(null);
  const [saving, setSaving] = useState(false);

  const active = editFleet ?? fleet;
  const dirty = editFleet !== null && JSON.stringify(active) !== JSON.stringify(fleet);

  // The server owns which roles exist; ROLE_COPY only supplies prose. A role
  // with no copy renders under its own key rather than vanishing from settings.
  const roles = Object.keys(fleet.models) as ModelFleetRole[];

  // Every gateway's copy of a model stays in the list. The aggregator repeats an
  // id across providers on purpose (`stepfun/step-3.7-flash` is served by
  // OpenRouter and KiloCode both) and the picker resolves a selection by
  // (id, gateway); this used to de-dupe by id, which made the second gateway's
  // copy impossible to choose at all.
  const models: AggregatedModel[] = modelsQ.data?.models ?? [];

  const setRole = (role: ModelFleetRole, modelId: string, provider: string) =>
    setEditFleet({
      models: { ...active.models, [role]: modelId },
      providers: { ...active.providers, [role]: modelId ? provider : '' },
    });

  const handleSave = async () => {
    if (!editFleet) return;
    setSaving(true);
    try {
      await updateModelFleet({ models: editFleet.models, providers: editFleet.providers });
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
    const blank = () =>
      Object.fromEntries(roles.map((role) => [role, ''])) as Record<ModelFleetRole, string>;
    setEditFleet({ models: blank(), providers: blank() });
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
            Choose a model for each cognitive role, and the gateway that serves
            it. Model ids repeat across providers —{' '}
            <span className="font-mono">stepfun/step-3.7-flash</span> is listed by
            OpenRouter and KiloCode both — so the gateway is part of the choice,
            not a detail. Leaving a field empty falls back to the chat session's
            model.
          </p>
        </div>

        <div className="space-y-4">
          {roles.map((role) => {
            const copy = ROLE_COPY[role];
            const value = active.models[role] ?? '';
            // The chain and the promotion sibling stay free-text: a chain is a
            // list of ids that may cross gateways on purpose, and both can name
            // a model the catalog has not loaded yet.
            const freeText = role === 'chat_chain' || role === 'chat_context_promotion';
            return (
              <div key={role} data-testid={`fleet-${role}-field`}>
                <WorkspaceField
                  label={copy?.label ?? role}
                  hint={copy?.hint ?? 'Background role. Empty = use the session model.'}
                >
                  {freeText ? (
                    <div className="flex items-center gap-2">
                      <input
                        value={value}
                        onChange={(e) => setRole(role, e.target.value, '')}
                        placeholder={
                          role === 'chat_chain'
                            ? 'model-a, model-b, model-c'
                            : 'larger-context-model'
                        }
                        className="flex-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs font-mono"
                        data-testid={`fleet-${role}-input`}
                      />
                      <button
                        type="button"
                        onClick={() => setRole(role, '', '')}
                        disabled={!value}
                        className="text-2xs text-muted-foreground hover:text-foreground underline disabled:opacity-30 disabled:cursor-not-allowed"
                        data-testid={`fleet-${role}-clear`}
                      >
                        Clear
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <ModelPickerDropdown
                        models={models}
                        value={value}
                        modelProvider={active.providers[role] ?? ''}
                        onChange={(modelId, provider) => setRole(role, modelId, provider)}
                      />
                      <button
                        type="button"
                        onClick={() => setRole(role, '', '')}
                        disabled={!value}
                        className="text-2xs text-muted-foreground hover:text-foreground underline disabled:opacity-30 disabled:cursor-not-allowed"
                        data-testid={`fleet-${role}-clear`}
                      >
                        Clear (use session model)
                      </button>
                    </div>
                  )}
                </WorkspaceField>
              </div>
            );
          })}
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
