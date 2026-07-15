/* Background & Reflection view — models for review, reflection, and
 * auto-memory extraction. When disabled or a slot is empty, background
 * tasks fall back to the active chat session model.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  getAggregatedModels,
  getReviewBackgroundConfig,
  updateReviewBackgroundConfig,
  type ReviewBackgroundConfig,
} from '@/api/api-client';
import { WorkspaceField } from '@/components/workspace/WorkspaceField';
import { WorkspaceToggle } from '@/components/workspace/WorkspaceToggle';
import { Button } from '@/components/ui/button';
import { ModelPickerDropdown } from '@/components/overlays/ModelPickerDropdown';
import { uniqueAggregatedModels } from './modelSettingsShared';

const DEFAULT_BG_CONFIG: ReviewBackgroundConfig = {
  enabled: false,
  reviewModel: '',
  reflectionModel: '',
  autoMemoryModel: '',
};

export function BackgroundReflectionTab() {
  const qc = useQueryClient();

  const bgQ = useQuery({
    queryKey: ['review-background-config'],
    queryFn: () => getReviewBackgroundConfig(),
  });
  const modelsQ = useQuery({
    queryKey: ['aggregated-models'],
    queryFn: () => getAggregatedModels(),
  });

  const config: ReviewBackgroundConfig = bgQ.data ?? DEFAULT_BG_CONFIG;
  const [editConfig, setEditConfig] = useState<ReviewBackgroundConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const activeConfig = editConfig ?? config;
  const dirty = editConfig !== null && JSON.stringify(editConfig) !== JSON.stringify(config);

  // Show ALL models from ALL providers — the ModelPickerDropdown groups them
  // by provider automatically. No provider pre-filter needed.
  const availableModels = uniqueAggregatedModels(modelsQ.data?.models);

  const handleSave = async () => {
    if (!editConfig) return;
    setSaving(true);
    try {
      await updateReviewBackgroundConfig(editConfig);
      setEditConfig(null);
        void qc.invalidateQueries({ queryKey: ['review-background-config'] });
        toast.success('Saved background review settings');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (bgQ.isLoading || modelsQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const noModels = availableModels.length === 0;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
        <div>
          <p className="text-sm font-semibold">Background review & reflection</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure separate models for background review, reflection, and auto‑memory extraction.
            When a task has no model selected (or background tasks are disabled), the chat session model is used automatically.
          </p>
        </div>

        <div className="flex items-center justify-between p-3 rounded-lg border border-white/[0.06] bg-black/10">
          <div>
            <p className="text-xs font-semibold">Enable background tasks</p>
            <p className="text-[10px] text-muted-foreground">Route background tasks to the models configured below.</p>
          </div>
          <WorkspaceToggle
            enabled={activeConfig.enabled}
            onToggle={(checked) => setEditConfig({ ...activeConfig, enabled: checked })}
            disabled={bgQ.isFetching}
          />
        </div>

        {noModels ? (
          <div className="p-3 rounded-lg border border-white/[0.06] bg-black/10 text-xs text-muted-foreground">
            No models available. Please add a provider first.
          </div>
        ) : (
          <div className="space-y-4">
            <WorkspaceField
              label="Review model"
              hint="Used for reviewing and summarising conversations."
            >
              <ModelPickerDropdown
                models={availableModels}
                value={activeConfig.reviewModel}
                onChange={(modelId) => setEditConfig({ ...activeConfig, reviewModel: modelId })}
                disabled={!activeConfig.enabled}
              />
            </WorkspaceField>

            <WorkspaceField
              label="Reflection model"
              hint="Used for the agent's self‑evaluation and learning loop."
            >
              <ModelPickerDropdown
                models={availableModels}
                value={activeConfig.reflectionModel}
                onChange={(modelId) => setEditConfig({ ...activeConfig, reflectionModel: modelId })}
                disabled={!activeConfig.enabled}
              />
            </WorkspaceField>

            <WorkspaceField
              label="Auto‑memory extraction model"
              hint="Used for extracting facts and storing them in memory."
            >
              <ModelPickerDropdown
                models={availableModels}
                value={activeConfig.autoMemoryModel}
                onChange={(modelId) => setEditConfig({ ...activeConfig, autoMemoryModel: modelId })}
                disabled={!activeConfig.enabled}
              />
            </WorkspaceField>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          If no model is selected for a task, the system will automatically use the chat session's model.
        </p>
      </div>

      <div className="flex items-center gap-2">
        {dirty && (
          <>
            <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditConfig(null)}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
