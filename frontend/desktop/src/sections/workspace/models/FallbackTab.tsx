/* Fallback view — sub-agent fallback when no alias session is active.
 * Chooses mode (session-only / marked / always / off) and a target model;
 * Test probes /api/config/subagent-fallback/test for resolution behavior.
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import {
  getAggregatedModels,
  getSubAgentFallback,
  updateSubAgentFallback,
  type SubAgentFallbackConfig,
} from '@/api/api-client';
import { WorkspaceField } from '@/components/workspace/WorkspaceField';
import { WorkspaceSelect } from '@/components/workspace/WorkspaceSelect';
import { WorkspaceToggle } from '@/components/workspace/WorkspaceToggle';
import { Button } from '@/components/ui/button';
import { ModelPickerDropdown } from '@/components/overlays/ModelPickerDropdown';
import { uniqueAggregatedModels } from './modelSettingsShared';

export function FallbackTab() {
  const qc = useQueryClient();
  const fallbackQ = useQuery({
    queryKey: ['subagent-fallback-config'],
    queryFn: () => getSubAgentFallback(),
  });
  const modelsQ = useQuery({
    queryKey: ['aggregated-models'],
    queryFn: () => getAggregatedModels(),
  });

  const [fallbackConfig, setFallbackConfig] = useState<SubAgentFallbackConfig>({
    enabled: false,
    mode: 'session_only',
    provider: '',
    model: '',
  });
  const [fallbackEdits, setFallbackEdits] = useState<SubAgentFallbackConfig | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (fallbackQ.data && fallbackEdits === null) {
      setFallbackConfig(fallbackQ.data);
    }
  }, [fallbackQ.data, fallbackEdits]);

  const activeFallback = fallbackEdits ?? fallbackConfig;
  const fallbackDirty = fallbackEdits !== null && JSON.stringify(fallbackEdits) !== JSON.stringify(fallbackConfig);

  const availableModels = uniqueAggregatedModels(modelsQ.data?.models);

  async function testFallback() {
    if (!activeFallback.enabled) {
      toast.warning('Enable fallback before testing');
      return;
    }
    setTesting(true);
    try {
      const data = await api.post<Record<string, unknown>>('/api/config/subagent-fallback/test', { model: 'probe-non-alias' });
      if (data?.translationWarning) toast.warning(data.translationWarning as string);
      if (data?.ok && (data.result as Record<string, unknown>)?.resolution) {
        const resolution = (data.result as Record<string, unknown>).resolution as Record<string, string>;
        toast.success(`Resolves to ${resolution.model} via ${resolution.provider}`);
      } else if ((data.result as Record<string, unknown>)?.action && ((data.result as Record<string, unknown>).action as string).startsWith('reject')) {
        toast.error(`Fallback rejected: ${(data.result as Record<string, unknown>).action as string}`);
      } else {
        toast.warning('Fallback did not resolve — check config or catalog state');
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-3 h-full flex flex-col">
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4 flex-1 overflow-auto">
        <div>
          <p className="text-sm font-semibold">Sub-agent fallback settings</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure a fallback model for incoming sub-agent/tool-call requests when there are no active alias sessions.
          </p>
        </div>

        <div className="flex items-center justify-between p-3 rounded-lg border border-white/[0.06] bg-black/10">
          <div>
            <p className="text-xs font-semibold">Enable fallback</p>
            <p className="text-[10px] text-muted-foreground">Route unknown/non-alias model requests to the fallback model.</p>
          </div>
          <WorkspaceToggle
            enabled={activeFallback.enabled}
            onToggle={(checked) => {
              const next = { ...activeFallback, enabled: checked };
              setFallbackEdits(next);
            }}
            disabled={fallbackQ.isFetching}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <WorkspaceField label="Fallback mode">
            <WorkspaceSelect
              value={activeFallback.mode}
              onChange={(e) => {
                const next = { ...activeFallback, mode: e.target.value as SubAgentFallbackConfig['mode'] };
                setFallbackEdits(next);
              }}
              options={[
                { value: 'session_only', label: 'Session only (highly recommended)' },
                { value: 'marked_subagent_only', label: 'Marked sub-agent only' },
                { value: 'always', label: 'Always' },
                { value: 'off', label: 'Off' }
              ]}
              disabled={!activeFallback.enabled}
            />
          </WorkspaceField>

          <WorkspaceField label="Fallback model">
            <ModelPickerDropdown
              models={availableModels}
              value={activeFallback.model}
              onChange={(modelId, provider) => {
                const next = { ...activeFallback, model: modelId, provider };
                setFallbackEdits(next);
              }}
              disabled={!activeFallback.enabled}
            />
          </WorkspaceField>
        </div>

        {activeFallback.enabled && activeFallback.mode === 'always' && (
          <div className="p-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 text-yellow-500 text-xs flex gap-2">
            <span className="font-semibold shrink-0">Warning:</span>
            <span>Always mode may route misspelled model names to the fallback instead of failing with an error.</span>
          </div>
        )}

        {activeFallback.enabled && activeFallback.model && (
          <p className="text-[10px] text-muted-foreground font-mono">
            Unknown sub-agent model requests will route to <code className="text-[10px] text-foreground">{activeFallback.model}</code>
            {activeFallback.provider && (
              <> via <code className="text-[10px] text-foreground">{activeFallback.provider}</code></>
            )}.
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void testFallback()}
            disabled={testing || !activeFallback.enabled}
          >
            {testing ? <Loader2 className="size-3 animate-spin" /> : <Bot className="size-3" />}
            Test fallback
          </Button>
          {fallbackDirty && (
            <>
              <Button size="sm" variant="outline" onClick={() => setFallbackEdits(null)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => {
                void (async () => {
                  try {
                    await updateSubAgentFallback(activeFallback);
                    setFallbackConfig(activeFallback);
                    setFallbackEdits(null);
                    void qc.invalidateQueries({ queryKey: ['subagent-fallback-config'] });
                    toast.success('Saved fallback settings');
                  } catch (e: unknown) {
                    toast.error(e instanceof Error ? e.message : 'Save failed');
                  }
                })();
              }}>
                <Check className="size-3" /> Save fallback settings
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
