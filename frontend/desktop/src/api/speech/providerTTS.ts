import type { LiveTTS } from './liveTTS';
import { liveClient } from '@/api/liveClient';

export class ProviderTTS implements LiveTTS {
  private audio: HTMLAudioElement | null = null;

  async speak(text: string, _voice?: string): Promise<void> {
    const result = await liveClient.synthesize(text, _voice ?? 'alloy');
    if (!result.audio) return;
    return new Promise((resolve) => {
      this.audio = new Audio(result.audio!);
      this.audio.onended = () => resolve();
      this.audio.play().catch(() => resolve());
    });
  }

  cancel(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
  }
}
