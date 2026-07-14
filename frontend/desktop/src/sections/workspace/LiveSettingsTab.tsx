/* Live settings: browser default or real OpenAI-compatible STT/TTS providers. */
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

interface Field {
  key: keyof LiveConfig;
  label: string;
  hint: string;
  inputType: 'select' | 'text';
  testid: string;
}

const FIELDS: Field[] = [
  {
    key: 'sttProvider',
    label: 'STT provider',
    hint: 'Empty = browser Web Speech. Set a provider with API key for server Whisper STT.',
    inputType: 'select',
    testid: 'live-stt-provider',
  },
  {
    key: 'sttModel',
    label: 'STT model',
    hint: 'Default whisper-1 for OpenAI-compatible APIs.',
    inputType: 'text',
    testid: 'live-stt-model',
  },
  {
    key: 'ttsProvider',
    label: 'TTS provider',
    hint: 'Empty = browser speechSynthesis. Set a provider for server TTS.',
    inputType: 'select',
    testid: 'live-tts-provider',
  },
  {
    key: 'ttsModel',
    label: 'TTS model',
    hint: 'Default tts-1 for OpenAI-compatible APIs.',
    inputType: 'text',
    testid: 'live-tts-model',
  },
  {
    key: 'ttsVoice',
    label: 'TTS voice',
    hint: 'e.g. alloy, nova, shimmer (server) or browser voice name.',
    inputType: 'text',
    testid: 'live-tts-voice',
  },
];

export function LiveSettingsTab() {
  const qc = useQueryClient();
  const { providers: availableProviders } = useProviderAvailability();

  const liveQ = useQuery({
    queryKey: ['live-config'],
    queryFn: () => getLiveConfig(),
  });

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

  const providerOptions = useMemo(
    () => [
      { value: '', label: '(browser default)' },
      ...availableProviders.map((p) => ({
        value: p.id,
        label: p.name || p.id,
      })),
    ],
    [availableProviders],
  );

  const handleSave = async () => {
    if (!editCfg) return;
    setSaving(true);
    try {
      await updateLiveConfig(editCfg);
      setEditCfg(null);
      void qc.invalidateQueries({ queryKey: ['live-config'] });
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
    setEditCfg({ ...active, [key]: value });
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
            Browser speech works with no config. Pick an OpenAI-compatible
            provider (with API key) for real server Whisper STT and TTS.
          </p>
        </div>

        <div className="space-y-4">
          {FIELDS.map(({ key, label, hint, inputType, testid }) => (
            <div key={key} data-testid={`${testid}-field`}>
              <WorkspaceField label={label} hint={hint}>
                {inputType === 'select' ? (
                  <select
                    value={active[key] ?? ''}
                    onChange={(e) => handleFieldChange(key, e.target.value)}
                    data-testid={`${testid}-input`}
                    className="w-full bg-black/20 border border-white/[0.06] rounded px-3 py-1.5 text-sm text-foreground focus:border-primary outline-none"
                  >
                    {providerOptions.map((opt) => (
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
                    placeholder={
                      key === 'sttModel'
                        ? 'whisper-1'
                        : key === 'ttsModel'
                          ? 'tts-1'
                          : key === 'ttsVoice'
                            ? 'alloy'
                            : ''
                    }
                    data-testid={`${testid}-input`}
                    className="w-full bg-black/20 border border-white/[0.06] rounded px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary outline-none"
                  />
                )}
              </WorkspaceField>
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => void handleSave()}
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="text-xs px-3 py-1.5 rounded border border-border"
          >
            Reset to browser defaults
          </button>
        </div>
      </div>
    </div>
  );
}
