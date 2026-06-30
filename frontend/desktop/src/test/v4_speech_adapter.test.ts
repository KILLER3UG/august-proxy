import { describe, it, expect } from 'vitest';
import { WebSpeechSTT } from '@/api/speech/webSpeechSTT';
import { ProviderSTT } from '@/api/speech/providerSTT';
import { liveSTTFactory } from '@/api/speech/liveSTT';
import { WebSpeechTTS } from '@/api/speech/webSpeechTTS';
import { ProviderTTS } from '@/api/speech/providerTTS';
import { liveTTSFactory } from '@/api/speech/liveTTS';

describe('v4 — LiveSTT adapters', () => {
  it('WebSpeechSTT conforms to LiveSTT shape', () => {
    const stt = new WebSpeechSTT();
    expect(typeof stt.start).toBe('function');
    expect(typeof stt.stop).toBe('function');
    expect(typeof stt.onPartial).toBe('function');
    expect(typeof stt.onFinal).toBe('function');
    expect(typeof stt.onError).toBe('function');
  });

  it('ProviderSTT conforms to LiveSTT shape', () => {
    const stt = new ProviderSTT();
    expect(typeof stt.start).toBe('function');
    expect(typeof stt.stop).toBe('function');
  });

  it('liveSTTFactory returns an instance with the right shape', () => {
    const stt = liveSTTFactory();
    expect(stt).toBeDefined();
  });

  it('WebSpeechSTT.onPartial returns an unsubscribe function', () => {
    const stt = new WebSpeechSTT();
    const unsub = stt.onPartial(() => {});
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

describe('v4 — LiveTTS adapters', () => {
  it('WebSpeechTTS conforms to LiveTTS shape', () => {
    const tts = new WebSpeechTTS();
    expect(typeof tts.speak).toBe('function');
    expect(typeof tts.cancel).toBe('function');
  });

  it('ProviderTTS conforms to LiveTTS shape', () => {
    const tts = new ProviderTTS();
    expect(typeof tts.speak).toBe('function');
    expect(typeof tts.cancel).toBe('function');
  });

  it('liveTTSFactory returns an instance', () => {
    const tts = liveTTSFactory();
    expect(tts).toBeDefined();
  });
});
