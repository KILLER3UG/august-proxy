/* v4.2 — Live settings tab: pick STT/TTS provider/model/voice.
   Empty values mean "use browser default" (Web Speech API / speechSynthesis).
   See spec §14. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { WorkspaceField } from '@/components/workspace/WorkspaceField';
import {
  getLiveConfig,
  updateLiveConfig,
  type LiveConfig,
} from '@/api/api-client';

interface Field {
  key: keyof LiveConfig;
  label: string;
  hint: string;
  inputType: 'text';
  testid: string;
}

const FIELDS: Field[] = [
  {
    key: 'sttProvider',
    label: 'STT provider',
    hint: 'Speech-to-text provider id (e.g. "openai", "deepgram"). Empty = browser Web Speech API.',
    inputType: 'text',
    testid: 'live-stt-provider',
  },
  {
    key: 'sttModel',
    label: 'STT model',
    hint: 'Provider-specific model id (e.g. "whisper-1", "gpt-4o-transcribe"). Empty = provider default.',
    inputType: 'text',
    testid: 'live-stt-model',
  },
  {
    key: 'ttsProvider',
    label: 'TTS provider',
    hint: 'Text-to-speech provider id (e.g. "openai", "elevenlabs", "piper"). Empty = browser speechSynthesis.',
    inputType: 'text',
    testid: 'live-tts-provider',
  },
  {
    key: 'ttsModel',
    label: 'TTS model',
    hint: 'Provider-specific model id (e.g. "tts-1", "eleven_multilingual_v2").',
    inputType: 'text',
    testid: 'live-tts-model',
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
            Leave any field empty to use the browser default (Web Speech API
            on Chromium browsers). Setting a provider upgrades transcription
            and voice quality.
          </p>
        </div>

        <div className="space-y-4">
          {FIELDS.map(({ key, label, hint, testid }) => (
            <div key={key} data-testid={`${testid}-field`}>
              <WorkspaceField label={label} hint={hint}>
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
