/**
 * LiveSTT — pluggable speech-to-text interface (v4 §14).
 *
 * Implementations: WebSpeechSTT (default when available), ProviderSTT (fallback / stub).
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

export function liveSTTFactory(): LiveSTT {
  if (typeof window !== 'undefined' && (window as any).SpeechRecognition) {
    return new WebSpeechSTT();
  }
  return new ProviderSTT();
}
