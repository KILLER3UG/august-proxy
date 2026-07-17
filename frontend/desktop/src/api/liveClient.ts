/**
 * liveClient — REST/SSE client for /api/live/* (v4 §14).
 *
 * v4 frontend-only cut: hits the existing stub endpoints. When the real
 * backend (§14 backend) ships, this module is the only place that needs
 * to change — the UI contracts stay stable.
 */

const API_BASE = '/api/live';

async function readErrorDetail(resp: Response): Promise<string> {
  try {
    const j = (await resp.json()) as { detail?: unknown; error?: unknown };
    if (typeof j.detail === 'string') return j.detail;
    if (j.detail && typeof j.detail === 'object' && 'message' in j.detail) {
      return String((j.detail).message);
    }
    if (typeof j.error === 'string') return j.error;
  } catch {
    /* ignore */
  }
  return `${resp.status} ${resp.statusText}`;
}

async function jsonRequest<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Session/turn callers expect null on failure; STT uses its own path that throws.
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
    // Real server STT accepts multipart at /stt/upload
    const resp = await fetch(`${API_BASE}/stt/upload`, { method: 'POST', body: form });
    if (resp.ok) {
      return (await resp.json()) as { transcript: string; partial: boolean };
    }
    if (resp.status === 501) {
      const detail = await readErrorDetail(resp);
      throw new Error(
        detail ||
          'Server STT is not configured. Use browser speech or set a Live STT provider with an API key.',
      );
    }
    // Fallback: base64 JSON body (some proxies strip multipart)
    const buf = await audio.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const j = await jsonRequest<{ transcript?: string }>('/stt', {
      audioBase64: b64,
      format: 'webm',
    });
    if (!j) {
      throw new Error(
        `Server STT failed (${resp.status}). Check Live STT provider/model and API key in Settings.`,
      );
    }
    return { transcript: j.transcript ?? '', partial: false };
  },

  async synthesize(text: string, voice: string): Promise<{ audio: string | null; format: string }> {
    const data = await jsonRequest<{ audio: string | null; format: string }>('/tts', { text, voice });
    return data ?? { audio: null, format: 'mp3' };
  },
};
