/**
 * LiveSTT — browser Web Speech when available; server ProviderSTT when
 * Live STT provider is configured; otherwise clear error (no silent stub).
 */

import { WebSpeechSTT } from './webSpeechSTT';
import { ProviderSTT } from './providerSTT';

export interface LiveSTT {
  start(): Promise<void>;
  stop(): Promise<void>;
  onPartial(callback: (text: string) => void): () => void;
  onFinal(callback: (text: string) => void): () => void;
  onError(callback: (err: Error) => void): () => void;
}

class UnavailableSTT implements LiveSTT {
  private errCbs: Array<(err: Error) => void> = [];
  async start(): Promise<void> {
    const err = new Error(
      'Speech recognition unavailable. Enable browser Web Speech or configure a Live STT provider in Settings.',
    );
    for (const cb of this.errCbs) cb(err);
  }
  async stop(): Promise<void> {}
  onPartial(_cb: (text: string) => void): () => void {
    return () => {};
  }
  onFinal(_cb: (text: string) => void): () => void {
    return () => {};
  }
  onError(callback: (err: Error) => void): () => void {
    this.errCbs.push(callback);
    return () => {
      this.errCbs = this.errCbs.filter(c => c !== callback);
    };
  }
}

function hasBrowserSpeech(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** Prefer browser; use server ProviderSTT when preferServer or no browser speech. */
export function liveSTTFactory(opts?: { preferServer?: boolean }): LiveSTT {
  if (!opts?.preferServer && hasBrowserSpeech()) {
    return new WebSpeechSTT();
  }
  // Server path when configured (ProviderSTT → /api/live/stt/upload)
  if (opts?.preferServer || !hasBrowserSpeech()) {
    return new ProviderSTT();
  }
  return new UnavailableSTT();
}
