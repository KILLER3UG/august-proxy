import type { LiveTTS } from './liveTTS';

export class WebSpeechTTS implements LiveTTS {
  private current: SpeechSynthesisUtterance | null = null;

  async speak(text: string, voice?: string): Promise<void> {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) {
        resolve();
        return;
      }
      const utt = new SpeechSynthesisUtterance(text);
      if (voice) {
        const v = window.speechSynthesis.getVoices().find((vv) => vv.name === voice);
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
