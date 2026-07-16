import { WebSpeechTTS } from './webSpeechTTS';
import { ProviderTTS } from './providerTTS';

export interface LiveTTS {
  speak(text: string, voice?: string): Promise<void>;
  cancel(): void;
}

export interface LiveTTSFactoryOpts {
  preferServer?: boolean;
  /** True when Settings Live TTS provider is set and has an API key. */
  serverConfigured?: boolean;
}

class UnavailableTTS implements LiveTTS {
  async speak(_text: string, _voice?: string): Promise<void> {
    // Silent no-op with console warning — TTS failure should not block Live.
    if (typeof console !== 'undefined') {
      console.warn(
        '[LiveTTS] Speech synthesis unavailable. Enable browser speechSynthesis or configure a Live TTS provider with an API key.',
      );
    }
  }
  cancel(): void {}
}

function hasBrowserTts(): boolean {
  return typeof window !== 'undefined' && Boolean(window.speechSynthesis);
}

/**
 * Prefer browser speechSynthesis unless server is preferred and configured.
 * Never call ProviderTTS (server) when not ready — avoids empty 501 loops.
 */
export function liveTTSFactory(opts?: LiveTTSFactoryOpts): LiveTTS {
  const serverConfigured = Boolean(opts?.serverConfigured);
  const preferServer = Boolean(opts?.preferServer);

  if (preferServer && serverConfigured) {
    return new ProviderTTS();
  }
  if (!preferServer && hasBrowserTts()) {
    return new WebSpeechTTS();
  }
  if (serverConfigured) {
    return new ProviderTTS();
  }
  if (hasBrowserTts()) {
    return new WebSpeechTTS();
  }
  return new UnavailableTTS();
}
