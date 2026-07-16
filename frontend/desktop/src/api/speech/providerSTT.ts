import type { LiveSTT } from './liveSTT';
import { liveClient } from '@/api/liveClient';

export class ProviderSTT implements LiveSTT {
  private partialListeners = new Set<(text: string) => void>();
  private finalListeners = new Set<(text: string) => void>();
  private errorListeners = new Set<(err: Error) => void>();
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  async start(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(stream);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      this.mediaRecorder.start(500); // 500ms chunks
    } catch (err) {
      this.errorListeners.forEach((cb) => cb(err as Error));
    }
  }

  async stop(): Promise<void> {
    if (!this.mediaRecorder) return;
    this.mediaRecorder.stop();
    const blob = new Blob(this.chunks, { type: 'audio/webm' });
    this.chunks = [];
    try {
      const result = await liveClient.transcribe(blob);
      if (result.transcript) {
        this.finalListeners.forEach((cb) => cb(result.transcript));
      } else {
        const err = new Error(
          'Server STT returned an empty transcript. Check Live STT provider/model and API key in Settings.',
        );
        this.errorListeners.forEach((cb) => cb(err));
      }
    } catch (err) {
      this.errorListeners.forEach((cb) =>
        cb(err instanceof Error ? err : new Error(String(err))),
      );
    }
  }

  onPartial(callback: (text: string) => void): () => void {
    this.partialListeners.add(callback);
    return () => this.partialListeners.delete(callback);
  }

  onFinal(callback: (text: string) => void): () => void {
    this.finalListeners.add(callback);
    return () => this.finalListeners.delete(callback);
  }

  onError(callback: (err: Error) => void): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }
}
