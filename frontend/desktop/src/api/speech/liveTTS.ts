import { WebSpeechTTS } from './webSpeechTTS';
import { ProviderTTS } from './providerTTS';

export interface LiveTTS {
  speak(text: string, voice?: string): Promise<void>;
  cancel(): void;
}

export function liveTTSFactory(): LiveTTS {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    return new WebSpeechTTS();
  }
  return new ProviderTTS();
}
