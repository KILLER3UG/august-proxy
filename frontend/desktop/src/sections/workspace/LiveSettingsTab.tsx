/* v4.2 — Live settings tab: pick STT/TTS provider/model/voice.
   Empty values mean "use provider default". Providers and models are
   sourced from the aggregated model list and provider availability,
   replacing the old text-input approach with <select> dropdowns.
   See spec §14. */
import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { WorkspaceField } from '@/components/workspace/WorkspaceField';
import {
  getLiveConfig,
  updateLiveConfig,
  type LiveConfig,
} from '@/api/api-client';
import { useProviderAvailability } from '@/hooks/useProviderAvailability';
import { useModels, type ModelItem } from '@/hooks/useModels';

interface Field<T = string> {
  key: keyof LiveConfig;
  label: string;
  hint: string;
  inputType: 'select' | 'text';
  testid: string;
  /** For 'select' fields: provide options. For provider fields, use
   *  the provider-availability hook; for model fields, filter by
   *  the selected provider. */
  dependsOn?: 'provider' | 'model';
}

const FIELDS: Field[] = [
  {
    key: 'sttProvider',
    label: 'STT provider',
    hint: 'Speech-to-text provider. Empty = browser Web Speech API.',
    inputType: 'select',
    testid: 'live-stt-provider',
  },
  {
    key: 'sttModel',
    label: 'STT model',
    hint: 'Provider-specific model id. Empty = provider default.',
    inputType: 'select',
    testid: 'live-stt-model',
    dependsOn: 'provider',
  },
  {
    key: 'ttsProvider',
    label: 'TTS provider',
    hint: 'Text-to-speech provider. Empty = browser speechSynthesis.',
    inputType: 'select',
    testid: 'live-tts-provider',
  },
  {
    key: 'ttsModel',
    label: 'TTS model',
    hint: 'Provider-specific model id. Empty = provider default.',
    inputType: 'select',
    testid: 'live-tts-model',
    dependsOn: 'provider',
  },
  {
    key: 'ttsVoice',
    label: 'TTS voice',
    hint: 'Voice name or id (e.g. "alloy", "nova", "shimmer").',
    inputType: 'text',
    testid: 'live-tts-voice',
  },
];

export function LiveSettingsTab() {
  const qc = useQueryClient();

  const liveQ = useQuery({
    queryKey: ['live-config'],
    queryFn: () => getLiveConfig(),
  });

  const { providers: availableProviders } = useProviderAvailability();
  const { models } = useModels();

  const initial: LiveConfig = liveQ.data ?? {
    sttProvider: '',
    sttModel: '',
    ttsProvider: '',
    ttsModel: '',
    ttsVoice: '',
  };
  const [editCfg, setEditCfg] = useState<LiveConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const active = editCfg ?? initial;
  const dirty =
    editCfg !== null && JSON.stringify(editCfg) !== JSON.stringify(initial);

  /** All unique provider names from the availability list. */
  const providerOptions = useMemo(
    () => [
      { value: '', label: '(use browser default)' },
      ...availableProviders.map((p) => ({
        value: p.id,
        label: p.name,
      })),
    ],
    [availableProviders],
  );

  /** Models filtered by the currently-selected provider for a given group. */
  const getModelOptions = (providerKey: keyof LiveConfig) => {
    const selectedProvider = active[providerKey === 'sttModel' ? 'sttProvider' : 'ttsProvider'];
    if (!selectedProvider) return [{ value: '', label: '(use provider default)' }];

    const filtered = models.filter(
      (m: ModelItem) => m.provider.toLowerCase() === selectedProvider.toLowerCase(),
    );
    return [
      { value: '', label: '(use provider default)' },
      ...filtered.map((m: ModelItem) => ({
        value: m.id,
        label: `${m.name} (${m.contextWindow?.toLocaleString() ?? '?'} ctx)`,
      })),
    ];
  };

  const handleSave = async () => {
    if (!editCfg) return;
    setSaving(true);
    try {
      await updateLiveConfig(editCfg);
      setEditCfg(null);
      qc.invalidateQueries({ queryKey: ['live-config'] });
      toast.success('Saved Live settings');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setEditCfg({
      sttProvider: '',
      sttModel: '',
      ttsProvider: '',
      ttsModel: '',
      ttsVoice: '',
    });
  };

  const handleFieldChange = (key: keyof LiveConfig, value: string) => {
    const next = { ...active, [key]: value };
    // If provider changed, clear the model selection
    if (key === 'sttProvider') next.sttModel = '';
    if (key === 'ttsProvider') next.ttsModel = '';
    setEditCfg(next);
  };

  if (liveQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
        <div>
          <p className="text-sm font-semibold">Live (STT/TTS) settings</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Choose speech-to-text and text-to-speech providers for August Live.
            Leave any field empty to use the default. Selecting a provider
            upgrades transcription and voice quality.
          </p>
        </div>

        <div className="space-y-4">
          {FIELDS.map(({ key, label, hint, inputType, testid, dependsOn }) => (
            <div key={key} data-testid={`${testid}-field`}>
              <WorkspaceField label={label} hint={hint}>
                {inputType === 'select' ? (
                  <select
                    value={active[key] ?? ''}
                    onChange={(e) =>
                      handleFieldChange(key, e.target.value)
                    }
                    data-testid={`${testid}-input`}
                    className="w-full bg-black/20 border border-white/[0.06] rounded px-3 py-1.5 text-sm text-foreground focus:border-primary outline-none"
                  >
                    {dependsOn === 'provider'
                      ? (key === 'sttModel' || key === 'ttsModel'
                          ? getModelOptions(key)
                          : providerOptions
                        ).map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))
                      : providerOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={active[key] ?? ''}
                    onChange={(e) =>
                      setEditCfg({ ...active, [key]: e.target.value })
                    }
                    placeholder="(use browser default)"
                    data-testid={`${testid}-input`}
                    className="w-full bg-black/20 border border-white/[0.06] rounded px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary outline-none"
                  />
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
            data-testid="live-reset"
          >
            Reset to defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEditCfg(null)}
              disabled={!dirty}
              className="px-3 py-1.5 text-xs rounded border border-white/[0.06] hover:bg-white/[0.06] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
              data-testid="live-save"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
