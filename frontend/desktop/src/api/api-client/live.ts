/* Live STT/TTS config — provider/model/voice selection for speech paths. */

import { api } from '../client';

// Empty provider = "use browser default" (Web Speech API). Setting a
// provider upgrades the speech path to a paid service. Mirrors model_fleet.
export interface LiveConfig {
  sttProvider: string;
  sttModel: string;
  ttsProvider: string;
  ttsModel: string;
  ttsVoice: string;
  /** Server Whisper STT is usable (provider selected + API key). */
  sttReady?: boolean;
  /** Server TTS is usable (provider selected + API key). */
  ttsReady?: boolean;
  sttMode?: 'server' | 'browser' | string;
  ttsMode?: 'server' | 'browser' | string;
  note?: string;
}

export function getLiveConfig(): Promise<LiveConfig> {
  return api.get<LiveConfig>('/api/config/live');
}

export function updateLiveConfig(patch: Partial<LiveConfig>): Promise<LiveConfig> {
  return api.put<LiveConfig>('/api/config/live', patch);
}
