import type { LiveTTS } from './liveTTS';
import { usePreferencesStore, voiceRate } from '@/lib/preferences';

export class WebSpeechTTS implements LiveTTS {
  private current: SpeechSynthesisUtterance | null = null;

  async speak(text: string, voice?: string): Promise<void> {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) {
        resolve();
        return;
      }
      const utt = new SpeechSynthesisUtterance(text);
      const prefs = usePreferencesStore.getState();
      // Voice speed from General → Preferences (slow 0.85 / normal 1 / fast 1.25).
      utt.rate = voiceRate(prefs.voice.speed);
      const available = window.speechSynthesis.getVoices();
      if (voice) {
        const v = available.find((vv) => vv.name === voice);
        if (v) utt.voice = v;
      } else if (prefs.voice.language) {
        // No explicit voice: prefer one matching the configured language.
        const lang = prefs.voice.language.toLowerCase();
        const v = available.find((vv) => vv.lang.toLowerCase().startsWith(lang));
        if (v) utt.voice = v;
      }
      utt.onend = () => resolve();
      this.current = utt;
      window.speechSynthesis.speak(utt);
    });
  }

  cancel(): void {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this.current = null;
  }
}
