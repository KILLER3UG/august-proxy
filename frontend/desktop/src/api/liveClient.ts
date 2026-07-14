/**
 * liveClient — REST/SSE client for /api/live/* (v4 §14).
 *
 * v4 frontend-only cut: hits the existing stub endpoints. When the real
 * backend (§14 backend) ships, this module is the only place that needs
 * to change — the UI contracts stay stable.
 */

const API_BASE = '/api/live';

async function jsonRequest<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

export const liveClient = {
  async startSession(): Promise<string> {
    // Wire format: camelCase (Phase 1+ migration standardized on camelCase).
    const data = await jsonRequest<{ sessionId?: string }>(
      '/session',
      { action: 'start' },
    );
    return data?.sessionId ?? '';
  },

  async stopSession(sessionId: string): Promise<void> {
    await jsonRequest('/session', { action: 'stop', sessionId });
  },

  async sendTurn(sessionId: string, transcript: string): Promise<string> {
    const data = await jsonRequest<{ content?: string }>('/turn', {
      sessionId,
      transcript,
    });
    return data?.content ?? '';
  },

  async transcribe(audio: Blob): Promise<{ transcript: string; partial: boolean }> {
    const form = new FormData();
    form.append('audio', audio, 'audio.webm');
    try {
      // Real server STT accepts multipart at /stt/upload
      const resp = await fetch(`${API_BASE}/stt/upload`, { method: 'POST', body: form });
      if (!resp.ok) {
        // Fallback: base64 JSON body
        const buf = await audio.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const j = await jsonRequest<{ transcript?: string }>('/stt', {
          audioBase64: b64,
          format: 'webm',
        });
        return { transcript: j?.transcript ?? '', partial: false };
      }
      return (await resp.json()) as { transcript: string; partial: boolean };
    } catch {
      return { transcript: '', partial: false };
    }
  },

  async synthesize(text: string, voice: string): Promise<{ audio: string | null; format: string }> {
    const data = await jsonRequest<{ audio: string | null; format: string }>('/tts', { text, voice });
    return data ?? { audio: null, format: 'mp3' };
  },
};
