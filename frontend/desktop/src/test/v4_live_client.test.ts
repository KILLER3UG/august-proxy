import { describe, it, expect, vi, beforeEach } from 'vitest';
import { liveClient } from '@/api/liveClient';

describe('v4 — liveClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('startSession posts to /api/live/session and returns sessionId', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ sessionId: 'live_abc', status: 'started' }),
    });
    const id = await liveClient.startSession();
    expect(id).toBe('live_abc');
    expect(fetch).toHaveBeenCalledWith(
      '/api/live/session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'start' }),
      }),
    );
  });

  it('stopSession posts to /api/live/session with action: stop', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => ({ status: 'stopped' }) });
    await liveClient.stopSession('live_abc');
    expect(fetch).toHaveBeenCalledWith(
      '/api/live/session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'stop', sessionId: 'live_abc' }),
      }),
    );
  });

  it('sendTurn posts to /api/live/turn and returns the assistant content', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ sessionId: 'live_abc', type: 'text', content: 'Processing: hello' }),
    });
    const text = await liveClient.sendTurn('live_abc', 'hello');
    expect(text).toBe('Processing: hello');
  });

  it('sendTurn returns empty string on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const text = await liveClient.sendTurn('live_abc', 'hi');
    expect(text).toBe('');
  });

  it('transcribe posts audio blob to /api/live/stt', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => ({ transcript: 'hi', partial: false }) });
    const result = await liveClient.transcribe(new Blob(['a']));
    expect(result.transcript).toBe('hi');
    expect(result.partial).toBe(false);
  });

  it('synthesize posts text to /api/live/tts and returns audio URL or null', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => ({ audio: null, format: 'mp3' }) });
    const result = await liveClient.synthesize('hi', 'alloy');
    expect(result.audio).toBeNull();
  });
});
