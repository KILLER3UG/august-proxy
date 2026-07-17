/**
 * LiveSTT — browser Web Speech when available; server ProviderSTT only when
 * Live STT provider is configured and ready; otherwise clear error (no silent 501).
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

export interface LiveSTTFactoryOpts {
  /** Prefer server STT even when browser speech exists. */
  preferServer?: boolean;
  /** True when Settings Live STT provider is set and has an API key. */
  serverConfigured?: boolean;
}

class UnavailableSTT implements LiveSTT {
  private errCbs: Array<(err: Error) => void> = [];
  private message: string;

  constructor(message?: string) {
    this.message =
      message ??
      'Speech recognition unavailable. Enable browser Web Speech or configure a Live STT provider (with API key) in Settings → Live.';
  }

  start(): Promise<void> {
    const err = new Error(this.message);
    for (const cb of this.errCbs) cb(err);
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
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

/**
 * Prefer browser Web Speech unless server is preferred and configured.
 * Never return ProviderSTT when server STT is not ready (avoids silent 501).
 */
export function liveSTTFactory(opts?: LiveSTTFactoryOpts): LiveSTT {
  const serverConfigured = Boolean(opts?.serverConfigured);
  const preferServer = Boolean(opts?.preferServer);

  if (preferServer && serverConfigured) {
    return new ProviderSTT();
  }
  if (!preferServer && hasBrowserSpeech()) {
    return new WebSpeechSTT();
  }
  if (serverConfigured) {
    return new ProviderSTT();
  }
  if (hasBrowserSpeech()) {
    return new WebSpeechSTT();
  }
  return new UnavailableSTT(
    preferServer
      ? 'Server STT is not ready. Set a Live STT provider with an API key in Settings, or use browser speech.'
      : undefined,
  );
}
