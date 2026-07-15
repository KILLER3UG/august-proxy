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
}

export function getLiveConfig(): Promise<LiveConfig> {
  return api.get<LiveConfig>('/api/config/live');
}

export function updateLiveConfig(patch: Partial<LiveConfig>): Promise<LiveConfig> {
  return api.put<LiveConfig>('/api/config/live', patch);
}
