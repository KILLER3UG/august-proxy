import type { LiveSTT } from './liveSTT';

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorLike extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export class WebSpeechSTT implements LiveSTT {
  private recognition: SpeechRecognitionLike | null = null;
  private partialListeners = new Set<(text: string) => void>();
  private finalListeners = new Set<(text: string) => void>();
  private errorListeners = new Set<(err: Error) => void>();

  async start(): Promise<void> {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) throw new Error('Web Speech API not available');
    const r = new Ctor() as unknown as SpeechRecognitionLike;
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let interim = '';
      let finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) this.partialListeners.forEach((cb) => cb(interim));
      if (finalText) this.finalListeners.forEach((cb) => cb(finalText));
    };
    r.onerror = (e) => {
      this.errorListeners.forEach((cb) => cb(new Error(e.error || 'speech_error')));
    };
    r.start();
    this.recognition = r;
  }

  async stop(): Promise<void> {
    this.recognition?.stop();
    this.recognition = null;
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
