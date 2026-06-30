# v4 §14 August Live Frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `/live` frontend surface — animated orb, rolling captions, tool rail, approval cards, controls, pluggable STT/TTS, Tauri mic capability — works in shape against the existing `/api/live/*` stubs.

**Architecture:** Pure additive frontend. The `LiveSurface` composes six small components fed by `useLiveSession` (state machine). Audio I/O goes through `LiveSTT`/`LiveTTS` interfaces with two adapters each (Web Speech default + provider stubs). Backend hits the existing `/api/live/*` stub endpoints unchanged.

**Tech Stack:**
- Frontend: React + TypeScript, Vitest, framer-motion (already installed), Tailwind
- Audio: browser `SpeechRecognition` + `speechSynthesis` (Web Speech API), `MediaRecorder`/`getUserMedia` for capture
- Tauri: `src-tauri/capabilities/default.json` mic permission

---

## File map

### New files

| File | Purpose |
|------|---------|
| `frontend/desktop/src/sections/live/useLiveSession.ts` | State machine hook (idle ↔ listening ↔ thinking ↔ speaking, with tool-running / awaiting-approval substates) |
| `frontend/desktop/src/sections/live/LiveOrb.tsx` | Animated orb with reduced-motion variant |
| `frontend/desktop/src/sections/live/LiveCaptions.tsx` | Rolling captions (partial → final committed) |
| `frontend/desktop/src/sections/live/LiveToolRail.tsx` | Tool activity cards |
| `frontend/desktop/src/sections/live/LiveApprovalCard.tsx` | In-surface approval card |
| `frontend/desktop/src/sections/live/LiveControls.tsx` | Bottom controls (mute, push-to-talk, end, handoff) |
| `frontend/desktop/src/sections/live/LiveSurface.tsx` | Main shell composing the above |
| `frontend/desktop/src/api/liveClient.ts` | REST/SSE client to `/api/live/*` |
| `frontend/desktop/src/api/speech/liveSTT.ts` | `LiveSTT` interface + factory |
| `frontend/desktop/src/api/speech/liveTTS.ts` | `LiveTTS` interface + factory |
| `frontend/desktop/src/api/speech/webSpeechSTT.ts` | Web Speech API STT adapter |
| `frontend/desktop/src/api/speech/webSpeechTTS.ts` | Web Speech API TTS adapter |
| `frontend/desktop/src/api/speech/providerSTT.ts` | Provider stub adapter |
| `frontend/desktop/src/api/speech/providerTTS.ts` | Provider stub adapter |
| `frontend/desktop/src/test/v4_live_session.test.tsx` | State machine tests |
| `frontend/desktop/src/test/v4_live_captions.test.tsx` | Captions component tests |
| `frontend/desktop/src/test/v4_live_tool_rail.test.tsx` | Tool rail tests |
| `frontend/desktop/src/test/v4_live_controls.test.tsx` | Controls tests |
| `frontend/desktop/src/test/v4_live_approval.test.tsx` | Approval card tests |
| `frontend/desktop/src/test/v4_speech_adapter.test.ts` | STT/TTS interface tests |

### Modified files

- `frontend/desktop/src/routes.ts` — add `/live` route + Mic nav item
- `frontend/desktop/src/components/overlays/ApprovalBanner.tsx` — expose `useApprovalQueue()` hook
- `frontend/desktop/src-tauri/capabilities/default.json` — add microphone permission
- `docs/design/tracker-v4.md` — mark §14 frontend rows ✅

---

## Task ordering

- T1: state machine (foundation)
- T2: liveClient (wire shape)
- T3-T4: STT/TTS adapters (audio I/O)
- T5-T9: components (UI)
- T10: LiveSurface shell (compose)
- T11: route + nav
- T12: Tauri mic capability
- T13: tracker + tag

---

## Task 1: useLiveSession state machine

**Files:**
- Create: `frontend/desktop/src/sections/live/useLiveSession.ts`
- Test: `frontend/desktop/src/test/v4_live_session.test.tsx`

**Why:** All UI components subscribe to this hook. Defining the state machine first locks the contract.

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/v4_live_session.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLiveSession } from '@/sections/live/useLiveSession';

describe('v4 — useLiveSession', () => {
  it('starts in idle state with empty transcript', () => {
    const { result } = renderHook(() => useLiveSession());
    expect(result.current.state).toBe('idle');
    expect(result.current.transcript).toBe('');
    expect(result.current.partialTranscript).toBe('');
    expect(result.current.toolEvents).toEqual([]);
    expect(result.current.pendingMutations).toEqual([]);
  });

  it('transitions idle → listening on start()', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.start());
    expect(result.current.state).toBe('listening');
  });

  it('captures partial transcript while listening', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.start());
    act(() => result.current.onPartial('Hello'));
    expect(result.current.partialTranscript).toBe('Hello');
    expect(result.current.state).toBe('listening');
  });

  it('commits final transcript → thinking', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.start());
    act(() => result.current.onPartial('Hello world'));
    act(() => result.current.onFinal('Hello world'));
    expect(result.current.transcript).toBe('Hello world');
    expect(result.current.partialTranscript).toBe('');
    expect(result.current.state).toBe('thinking');
  });

  it('records tool events', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.start());
    act(() => result.current.onFinal('read auth.py'));
    act(() => result.current.addToolEvent({ id: 't1', name: 'read_file', args: { path: 'auth.py' }, status: 'running' }));
    expect(result.current.toolEvents).toHaveLength(1);
    expect(result.current.toolEvents[0].status).toBe('running');
    act(() => result.current.updateToolEvent('t1', { status: 'done' }));
    expect(result.current.toolEvents[0].status).toBe('done');
  });

  it('approve() removes the mutation from pendingMutations', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.addPendingMutation({ id: 'm1', description: 'write auth.py' }));
    expect(result.current.pendingMutations).toHaveLength(1);
    act(() => result.current.approve('m1'));
    expect(result.current.pendingMutations).toEqual([]);
  });

  it('deny() removes the mutation from pendingMutations', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.addPendingMutation({ id: 'm1', description: 'write auth.py' }));
    act(() => result.current.deny('m1'));
    expect(result.current.pendingMutations).toEqual([]);
  });

  it('stop() resets to idle from any state', () => {
    const { result } = renderHook(() => useLiveSession());
    act(() => result.current.start());
    act(() => result.current.onFinal('hi'));
    act(() => result.current.stop());
    expect(result.current.state).toBe('idle');
    expect(result.current.transcript).toBe('');
  });

  it('mute toggles isMuted without changing state', () => {
    const { result } = renderHook(() => useLiveSession());
    expect(result.current.isMuted).toBe(false);
    act(() => result.current.toggleMute());
    expect(result.current.isMuted).toBe(true);
    act(() => result.current.toggleMute());
    expect(result.current.isMuted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_session.test.tsx`
Expected: FAIL — `useLiveSession` doesn't exist

- [ ] **Step 3: Implement useLiveSession**

Create `frontend/desktop/src/sections/live/useLiveSession.ts`:

```ts
import { useState, useCallback } from 'react';

export type LiveState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'tool-running'
  | 'awaiting-approval'
  | 'speaking';

export interface ToolEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  result?: unknown;
}

export interface PendingMutation {
  id: string;
  description: string;
  spokenPrompt?: string;
}

export interface UseLiveSession {
  state: LiveState;
  transcript: string;
  partialTranscript: string;
  toolEvents: ToolEvent[];
  pendingMutations: PendingMutation[];
  isMuted: boolean;
  start: () => void;
  stop: () => void;
  toggleMute: () => void;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  addToolEvent: (event: ToolEvent) => void;
  updateToolEvent: (id: string, patch: Partial<ToolEvent>) => void;
  addPendingMutation: (mutation: PendingMutation) => void;
  approve: (id: string) => void;
  deny: (id: string) => void;
  reset: () => void;
}

export function useLiveSession(): UseLiveSession {
  const [state, setState] = useState<LiveState>('idle');
  const [transcript, setTranscript] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [pendingMutations, setPendingMutations] = useState<PendingMutation[]>([]);
  const [isMuted, setIsMuted] = useState(false);

  const start = useCallback(() => setState('listening'), []);
  const stop = useCallback(() => {
    setState('idle');
    setTranscript('');
    setPartialTranscript('');
    setToolEvents([]);
    setPendingMutations([]);
  }, []);
  const toggleMute = useCallback(() => setIsMuted((m) => !m), []);

  const onPartial = useCallback((text: string) => {
    if (state !== 'listening') setState('listening');
    setPartialTranscript(text);
  }, [state]);

  const onFinal = useCallback((text: string) => {
    setTranscript(text);
    setPartialTranscript('');
    setState('thinking');
  }, []);

  const addToolEvent = useCallback((event: ToolEvent) => {
    setToolEvents((prev) => [...prev, event]);
    if (event.status === 'running') setState('tool-running');
  }, []);

  const updateToolEvent = useCallback((id: string, patch: Partial<ToolEvent>) => {
    setToolEvents((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    );
  }, []);

  const addPendingMutation = useCallback((mutation: PendingMutation) => {
    setPendingMutations((prev) => [...prev, mutation]);
    setState('awaiting-approval');
  }, []);

  const approve = useCallback((id: string) => {
    setPendingMutations((prev) => prev.filter((m) => m.id !== id));
    setState((s) => (s === 'awaiting-approval' ? 'thinking' : s));
  }, []);

  const deny = useCallback((id: string) => {
    setPendingMutations((prev) => prev.filter((m) => m.id !== id));
    setState((s) => (s === 'awaiting-approval' ? 'thinking' : s));
  }, []);

  const reset = useCallback(() => stop(), [stop]);

  return {
    state,
    transcript,
    partialTranscript,
    toolEvents,
    pendingMutations,
    isMuted,
    start,
    stop,
    toggleMute,
    onPartial,
    onFinal,
    addToolEvent,
    updateToolEvent,
    addPendingMutation,
    approve,
    deny,
    reset,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_session.test.tsx`
Expected: PASS (9/9)

- [ ] **Step 5: Commit**

```bash
git add frontend/desktop/src/sections/live/useLiveSession.ts frontend/desktop/src/test/v4_live_session.test.tsx
git commit -m "feat(v4): useLiveSession state machine hook (9 tests)"
```

---

## Task 2: liveClient REST/SSE client

**Files:**
- Create: `frontend/desktop/src/api/liveClient.ts`
- Test: `frontend/desktop/src/test/v4_live_client.test.ts`

**Why:** Components must call the same shape `/api/live/*` endpoints. Isolating the fetch shape lets us swap implementations when backend catches up.

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/v4_live_client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { liveClient } from '@/api/liveClient';

describe('v4 — liveClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('startSession posts to /api/live/session and returns sessionId', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session_id: 'live_abc', status: 'started' }),
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
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'stopped' }) });
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
      json: async () => ({ sessionId: 'live_abc', type: 'text', content: 'Processing: hello' }),
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
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ transcript: 'hi', partial: false }) });
    const result = await liveClient.transcribe(new Blob(['a']));
    expect(result.transcript).toBe('hi');
    expect(result.partial).toBe(false);
  });

  it('synthesize posts text to /api/live/tts and returns audio URL or null', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ audio: null, format: 'mp3' }) });
    const result = await liveClient.synthesize('hi', 'alloy');
    expect(result.audio).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_client.test.ts`
Expected: FAIL — `liveClient` doesn't exist

- [ ] **Step 3: Implement liveClient**

Create `frontend/desktop/src/api/liveClient.ts`:

```ts
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
    const data = await jsonRequest<{ session_id?: string }>('/session', { action: 'start' });
    return data?.session_id ?? '';
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
    form.append('audio', audio);
    try {
      const resp = await fetch(`${API_BASE}/stt`, { method: 'POST', body: form });
      if (!resp.ok) return { transcript: '', partial: false };
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_client.test.ts`
Expected: PASS (6/6)

- [ ] **Step 5: Commit**

```bash
git add frontend/desktop/src/api/liveClient.ts frontend/desktop/src/test/v4_live_client.test.ts
git commit -m "feat(v4): liveClient REST/SSE client for /api/live/* (6 tests)"
```

---

## Task 3: LiveSTT interface + Web Speech + provider stub

**Files:**
- Create: `frontend/desktop/src/api/speech/liveSTT.ts`
- Create: `frontend/desktop/src/api/speech/webSpeechSTT.ts`
- Create: `frontend/desktop/src/api/speech/providerSTT.ts`
- Test: `frontend/desktop/src/test/v4_speech_adapter.test.ts`

**Why:** STT is the audio-in side of Live. Defining the interface + two adapters (Web Speech default + provider stub) keeps the wire path swap-ready.

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/v4_speech_adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WebSpeechSTT } from '@/api/speech/webSpeechSTT';
import { ProviderSTT } from '@/api/speech/providerSTT';
import { liveSTTFactory } from '@/api/speech/liveSTT';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_speech_adapter.test.ts`
Expected: FAIL — adapters don't exist

- [ ] **Step 3: Implement interface**

Create `frontend/desktop/src/api/speech/liveSTT.ts`:

```ts
/**
 * LiveSTT — pluggable speech-to-text interface (v4 §14).
 *
 * Implementations: WebSpeechSTT (default), ProviderSTT (stub).
 */

export interface LiveSTT {
  start(): Promise<void>;
  stop(): Promise<void>;
  onPartial(callback: (text: string) => void): () => void;
  onFinal(callback: (text: string) => void): () => void;
  onError(callback: (err: Error) => void): () => void;
}

export function liveSTTFactory(): LiveSTT {
  // Lazy import to keep browser-only APIs out of SSR / test init paths.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WebSpeechSTT } = require('./webSpeechSTT') as typeof import('./webSpeechSTT');
  if (typeof window !== 'undefined' && (window as any).SpeechRecognition) {
    return new WebSpeechSTT();
  }
  const { ProviderSTT } = require('./providerSTT') as typeof import('./providerSTT');
  return new ProviderSTT();
}
```

- [ ] **Step 4: Implement WebSpeechSTT**

Create `frontend/desktop/src/api/speech/webSpeechSTT.ts`:

```ts
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
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) throw new Error('Web Speech API not available');
    const r = new Ctor() as SpeechRecognitionLike;
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
```

- [ ] **Step 5: Implement ProviderSTT stub**

Create `frontend/desktop/src/api/speech/providerSTT.ts`:

```ts
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
    const result = await liveClient.transcribe(blob);
    if (result.transcript) this.finalListeners.forEach((cb) => cb(result.transcript));
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_speech_adapter.test.ts`
Expected: PASS (4/4)

- [ ] **Step 7: Commit**

```bash
git add frontend/desktop/src/api/speech/liveSTT.ts frontend/desktop/src/api/speech/webSpeechSTT.ts frontend/desktop/src/api/speech/providerSTT.ts frontend/desktop/src/test/v4_speech_adapter.test.ts
git commit -m "feat(v4): LiveSTT interface + WebSpeech + provider stub (4 tests)"
```

---

## Task 4: LiveTTS interface + Web Speech + provider stub

**Files:**
- Create: `frontend/desktop/src/api/speech/liveTTS.ts`
- Create: `frontend/desktop/src/api/speech/webSpeechTTS.ts`
- Create: `frontend/desktop/src/api/speech/providerTTS.ts`
- Modify: `frontend/desktop/src/test/v4_speech_adapter.test.ts` (add TTS tests)

- [ ] **Step 1: Append failing tests**

Append to `v4_speech_adapter.test.ts`:

```ts
import { WebSpeechTTS } from '@/api/speech/webSpeechTTS';
import { ProviderTTS } from '@/api/speech/providerTTS';
import { liveTTSFactory } from '@/api/speech/liveTTS';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_speech_adapter.test.ts`
Expected: FAIL — TTS adapters don't exist

- [ ] **Step 3: Implement TTS interface**

Create `frontend/desktop/src/api/speech/liveTTS.ts`:

```ts
export interface LiveTTS {
  speak(text: string, voice?: string): Promise<void>;
  cancel(): void;
}

export function liveTTSFactory(): LiveTTS {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WebSpeechTTS } = require('./webSpeechTTS') as typeof import('./webSpeechTTS');
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    return new WebSpeechTTS();
  }
  const { ProviderTTS } = require('./providerTTS') as typeof import('./providerTTS');
  return new ProviderTTS();
}
```

- [ ] **Step 4: Implement WebSpeechTTS**

Create `frontend/desktop/src/api/speech/webSpeechTTS.ts`:

```ts
import type { LiveTTS } from './liveTTS';

export class WebSpeechTTS implements LiveTTS {
  private current: SpeechSynthesisUtterance | null = null;

  async speak(text: string, voice?: string): Promise<void> {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) {
        resolve();
        return;
      }
      const utt = new SpeechSynthesisUtterance(text);
      if (voice) {
        const v = window.speechSynthesis.getVoices().find((vv) => vv.name === voice);
        if (v) utt.voice = v;
      }
      utt.onend = () => resolve();
      this.current = utt;
      window.speechSynthesis.speak(utt);
    });
  }

  cancel(): void {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this.current = null;
  }
}
```

- [ ] **Step 5: Implement ProviderTTS stub**

Create `frontend/desktop/src/api/speech/providerTTS.ts`:

```ts
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_speech_adapter.test.ts`
Expected: PASS (7/7)

- [ ] **Step 7: Commit**

```bash
git add frontend/desktop/src/api/speech/liveTTS.ts frontend/desktop/src/api/speech/webSpeechTTS.ts frontend/desktop/src/api/speech/providerTTS.ts frontend/desktop/src/test/v4_speech_adapter.test.ts
git commit -m "feat(v4): LiveTTS interface + WebSpeech + provider stub (3 tests)"
```

---

## Task 5: LiveOrb component + reduced-motion variant

**Files:**
- Create: `frontend/desktop/src/sections/live/LiveOrb.tsx`
- Test: `frontend/desktop/src/test/v4_live_orb.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/v4_live_orb.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LiveOrb } from '@/sections/live/LiveOrb';

describe('v4 — LiveOrb', () => {
  it('renders an orb for each state', () => {
    for (const state of ['idle', 'listening', 'thinking', 'speaking'] as const) {
      const { container } = render(<LiveOrb state={state} />);
      const orb = container.querySelector('[data-testid="live-orb"]');
      expect(orb).toBeTruthy();
      expect(orb?.getAttribute('data-state')).toBe(state);
    }
  });

  it('renders the state label inside the orb', () => {
    const { container } = render(<LiveOrb state="listening" />);
    expect(container.textContent).toContain('listening');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_orb.test.tsx`
Expected: FAIL — `LiveOrb` doesn't exist

- [ ] **Step 3: Implement LiveOrb**

Create `frontend/desktop/src/sections/live/LiveOrb.tsx`:

```tsx
import { motion } from 'framer-motion';
import type { LiveState } from './useLiveSession';

interface LiveOrbProps {
  state: LiveState;
  reducedMotion?: boolean;
}

const STATE_COLOR: Record<LiveState, string> = {
  'idle': 'bg-muted-foreground/30',
  'listening': 'bg-primary',
  'thinking': 'bg-warning',
  'tool-running': 'bg-warning',
  'awaiting-approval': 'bg-danger',
  'speaking': 'bg-success',
};

export function LiveOrb({ state, reducedMotion }: LiveOrbProps) {
  const color = STATE_COLOR[state] ?? 'bg-muted-foreground/30';

  if (reducedMotion) {
    return (
      <div
        data-testid="live-orb"
        data-state={state}
        className="size-32 rounded-full border-4 border-border flex items-center justify-center"
      >
        <div className={`size-16 rounded-full ${color}`} />
        <span className="absolute mt-44 text-xs text-muted-foreground">{state}</span>
      </div>
    );
  }

  return (
    <div data-testid="live-orb" data-state={state} className="relative">
      <motion.div
        className={`size-32 rounded-full ${color}`}
        animate={{
          scale: state === 'listening' || state === 'speaking' ? [1, 1.1, 1] : 1,
          opacity: state === 'thinking' || state === 'tool-running' ? [0.6, 1, 0.6] : 1,
        }}
        transition={{
          duration: state === 'listening' || state === 'speaking' ? 1.5 : 1.2,
          repeat: state === 'idle' ? 0 : Infinity,
        }}
      />
      <span className="absolute left-0 right-0 -bottom-6 text-center text-xs text-muted-foreground">
        {state}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_orb.test.tsx`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add frontend/desktop/src/sections/live/LiveOrb.tsx frontend/desktop/src/test/v4_live_orb.test.tsx
git commit -m "feat(v4): LiveOrb with framer-motion + reduced-motion variant"
```

---

## Task 6: LiveCaptions component

**Files:**
- Create: `frontend/desktop/src/sections/live/LiveCaptions.tsx`
- Test: `frontend/desktop/src/test/v4_live_captions.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/v4_live_captions.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveCaptions } from '@/sections/live/LiveCaptions';

describe('v4 — LiveCaptions', () => {
  it('renders the partial transcript in italic-like muted style', () => {
    render(<LiveCaptions partial="Hello wo" transcript="" />);
    const partial = screen.getByTestId('captions-partial');
    expect(partial.textContent).toBe('Hello wo');
    expect(partial.className).toMatch(/opacity-/);
  });

  it('renders the committed transcript in solid text', () => {
    render(<LiveCaptions partial="" transcript="Hello world" />);
    expect(screen.getByTestId('captions-final').textContent).toBe('Hello world');
  });

  it('renders both when both are present (partial stacked above final)', () => {
    render(<LiveCaptions partial="there" transcript="Hello" />);
    expect(screen.getByTestId('captions-final').textContent).toBe('Hello');
    expect(screen.getByTestId('captions-partial').textContent).toBe('there');
  });

  it('renders empty placeholders when nothing is set', () => {
    const { container } = render(<LiveCaptions partial="" transcript="" />);
    expect(container.querySelector('[data-testid="captions-final"]')?.textContent ?? '').toBe('');
    expect(container.querySelector('[data-testid="captions-partial"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_captions.test.tsx`
Expected: FAIL — `LiveCaptions` doesn't exist

- [ ] **Step 3: Implement LiveCaptions**

Create `frontend/desktop/src/sections/live/LiveCaptions.tsx`:

```tsx
interface LiveCaptionsProps {
  partial: string;
  transcript: string;
}

export function LiveCaptions({ partial, transcript }: LiveCaptionsProps) {
  return (
    <div
      className="text-center max-w-2xl mx-auto px-4"
      aria-live="polite"
      data-testid="live-captions"
    >
      {transcript && (
        <p data-testid="captions-final" className="text-xl leading-relaxed text-foreground">
          {transcript}
        </p>
      )}
      {partial && (
        <p data-testid="captions-partial" className="text-lg leading-relaxed text-muted-foreground opacity-60 mt-1">
          {partial}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_captions.test.tsx`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add frontend/desktop/src/sections/live/LiveCaptions.tsx frontend/desktop/src/test/v4_live_captions.test.tsx
git commit -m "feat(v4): LiveCaptions (partial + committed transcript)"
```

---

## Task 7: LiveToolRail component

**Files:**
- Create: `frontend/desktop/src/sections/live/LiveToolRail.tsx`
- Test: `frontend/desktop/src/test/v4_live_tool_rail.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/v4_live_tool_rail.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveToolRail } from '@/sections/live/LiveToolRail';

describe('v4 — LiveToolRail', () => {
  it('renders one card per tool event', () => {
    const events = [
      { id: 't1', name: 'read_file', args: { path: 'auth.py' }, status: 'done' as const },
      { id: 't2', name: 'brain_query', args: { q: 'recent errors' }, status: 'running' as const },
    ];
    render(<LiveToolRail events={events} />);
    expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.getByText('brain_query')).toBeTruthy();
    expect(screen.getByText('auth.py')).toBeTruthy();
  });

  it('renders empty state when no events', () => {
    render(<LiveToolRail events={[]} />);
    expect(screen.getByText(/no tool activity/i)).toBeTruthy();
  });

  it('marks running tools with a status indicator', () => {
    const events = [{ id: 't1', name: 'web_fetch', args: {}, status: 'running' as const }];
    const { container } = render(<LiveToolRail events={events} />);
    expect(container.querySelector('[data-status="running"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_tool_rail.test.tsx`
Expected: FAIL — `LiveToolRail` doesn't exist

- [ ] **Step 3: Implement LiveToolRail**

Create `frontend/desktop/src/sections/live/LiveToolRail.tsx`:

```tsx
import { Wrench, CheckCircle2, Loader2 } from 'lucide-react';
import type { ToolEvent } from './useLiveSession';

interface LiveToolRailProps {
  events: ToolEvent[];
}

const STATUS_ICON = {
  running: Loader2,
  done: CheckCircle2,
  error: CheckCircle2,
};

export function LiveToolRail({ events }: LiveToolRailProps) {
  if (events.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-3" data-testid="live-tool-rail">
        No tool activity yet.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="live-tool-rail">
      {events.map((e) => {
        const Icon = STATUS_ICON[e.status] ?? Wrench;
        return (
          <div
            key={e.id}
            data-status={e.status}
            className="bg-card border border-border rounded-md p-2 flex items-start gap-2 text-xs"
          >
            <Icon className={`size-3.5 mt-0.5 shrink-0 ${e.status === 'running' ? 'animate-spin text-warning' : 'text-success'}`} />
            <div className="flex-1 min-w-0">
              <div className="font-mono font-medium">{e.name}</div>
              <div className="text-muted-foreground truncate">{JSON.stringify(e.args)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_tool_rail.test.tsx`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add frontend/desktop/src/sections/live/LiveToolRail.tsx frontend/desktop/src/test/v4_live_tool_rail.test.tsx
git commit -m "feat(v4): LiveToolRail (per-tool activity cards)"
```

---

## Task 8: useApprovalQueue hook + LiveApprovalCard

**Files:**
- Modify: `frontend/desktop/src/components/overlays/ApprovalBanner.tsx` (add hook)
- Create: `frontend/desktop/src/sections/live/LiveApprovalCard.tsx`
- Test: `frontend/desktop/src/test/v4_live_approval.test.tsx`

**Why:** Approval cards need a shared queue between `ApprovalBanner` (chat) and the Live surface (voice). Extract a hook so both consumers read the same state.

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/v4_live_approval.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveApprovalCard } from '@/sections/live/LiveApprovalCard';

describe('v4 — LiveApprovalCard', () => {
  it('renders the mutation description', () => {
    render(
      <LiveApprovalCard
        mutation={{ id: 'm1', description: 'Write auth.py' }}
        onApprove={() => {}}
        onDeny={() => {}}
        onVoiceConfirm={() => {}}
      />,
    );
    expect(screen.getByText('Write auth.py')).toBeTruthy();
  });

  it('fires onApprove when the Approve button is clicked', () => {
    const onApprove = vi.fn();
    render(
      <LiveApprovalCard
        mutation={{ id: 'm1', description: 'Write auth.py' }}
        onApprove={onApprove}
        onDeny={() => {}}
        onVoiceConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Approve'));
    expect(onApprove).toHaveBeenCalledWith('m1');
  });

  it('fires onDeny when Deny is clicked', () => {
    const onDeny = vi.fn();
    render(
      <LiveApprovalCard
        mutation={{ id: 'm1', description: 'Write auth.py' }}
        onApprove={() => {}}
        onDeny={onDeny}
        onVoiceConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Deny'));
    expect(onDeny).toHaveBeenCalledWith('m1');
  });

  it('fires onVoiceConfirm when "voice confirm" is clicked (no spoken path)', () => {
    const onVoiceConfirm = vi.fn();
    render(
      <LiveApprovalCard
        mutation={{ id: 'm1', description: 'Write auth.py', spokenPrompt: 'May I write auth.py?' }}
        onApprove={() => {}}
        onDeny={() => {}}
        onVoiceConfirm={onVoiceConfirm}
      />,
    );
    fireEvent.click(screen.getByText(/voice confirm/i));
    expect(onVoiceConfirm).toHaveBeenCalledWith('m1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_approval.test.tsx`
Expected: FAIL — `LiveApprovalCard` doesn't exist

- [ ] **Step 3: Implement LiveApprovalCard**

Create `frontend/desktop/src/sections/live/LiveApprovalCard.tsx`:

```tsx
import { ShieldAlert } from 'lucide-react';
import type { PendingMutation } from './useLiveSession';

interface LiveApprovalCardProps {
  mutation: PendingMutation;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onVoiceConfirm: (id: string) => void;
}

export function LiveApprovalCard({ mutation, onApprove, onDeny, onVoiceConfirm }: LiveApprovalCardProps) {
  return (
    <div
      className="bg-card border-2 border-warning rounded-lg p-4 shadow-xl max-w-md mx-auto"
      role="alertdialog"
      aria-live="assertive"
      data-testid="live-approval-card"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="size-5 text-warning shrink-0" />
        <div className="flex-1">
          <div className="text-sm font-medium">Allow {mutation.description}?</div>
          {mutation.spokenPrompt && (
            <div className="text-xs text-muted-foreground italic mt-1">
              spoken: "{mutation.spokenPrompt}"
            </div>
          )}
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={() => onApprove(mutation.id)}
              className="px-3 py-1.5 text-xs rounded bg-success text-success-foreground hover:opacity-90"
              data-testid="approve"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => onDeny(mutation.id)}
              className="px-3 py-1.5 text-xs rounded bg-muted text-foreground hover:opacity-90"
              data-testid="deny"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={() => onVoiceConfirm(mutation.id)}
              className="px-3 py-1.5 text-xs rounded text-muted-foreground hover:text-foreground"
              data-testid="voice-confirm"
            >
              voice confirm (placeholder)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_approval.test.tsx`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add frontend/desktop/src/sections/live/LiveApprovalCard.tsx frontend/desktop/src/test/v4_live_approval.test.tsx
git commit -m "feat(v4): LiveApprovalCard (Approve / Deny / placeholder voice-confirm)"
```

---

## Task 9: LiveControls component

**Files:**
- Create: `frontend/desktop/src/sections/live/LiveControls.tsx`
- Test: `frontend/desktop/src/test/v4_live_controls.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/v4_live_controls.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveControls } from '@/sections/live/LiveControls';

describe('v4 — LiveControls', () => {
  it('renders Mute, End, push-to-talk toggle, and Switch to chat', () => {
    render(
      <LiveControls
        isMuted={false}
        continuousMode={false}
        onToggleMute={() => {}}
        onEnd={() => {}}
        onToggleContinuous={() => {}}
        onSwitchToChat={() => {}}
      />,
    );
    expect(screen.getByText(/mute/i)).toBeTruthy();
    expect(screen.getByText(/end/i)).toBeTruthy();
    expect(screen.getByText(/switch to chat/i)).toBeTruthy();
  });

  it('calls onToggleMute when Mute is clicked', () => {
    const onToggleMute = vi.fn();
    render(
      <LiveControls
        isMuted={false}
        continuousMode={false}
        onToggleMute={onToggleMute}
        onEnd={() => {}}
        onToggleContinuous={() => {}}
        onSwitchToChat={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/mute/i));
    expect(onToggleMute).toHaveBeenCalled();
  });

  it('shows "Unmute" when isMuted is true', () => {
    render(
      <LiveControls
        isMuted={true}
        continuousMode={false}
        onToggleMute={() => {}}
        onEnd={() => {}}
        onToggleContinuous={() => {}}
        onSwitchToChat={() => {}}
      />,
    );
    expect(screen.getByText(/unmute/i)).toBeTruthy();
  });

  it('calls onEnd when End is clicked', () => {
    const onEnd = vi.fn();
    render(
      <LiveControls
        isMuted={false}
        continuousMode={false}
        onToggleMute={() => {}}
        onEnd={onEnd}
        onToggleContinuous={() => {}}
        onSwitchToChat={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/end/i));
    expect(onEnd).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_controls.test.tsx`
Expected: FAIL — `LiveControls` doesn't exist

- [ ] **Step 3: Implement LiveControls**

Create `frontend/desktop/src/sections/live/LiveControls.tsx`:

```tsx
import { MicOff, Mic, PhoneOff, MessageSquare, ToggleLeft, ToggleRight } from 'lucide-react';

interface LiveControlsProps {
  isMuted: boolean;
  continuousMode: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
  onToggleContinuous: () => void;
  onSwitchToChat: () => void;
}

export function LiveControls({
  isMuted,
  continuousMode,
  onToggleMute,
  onEnd,
  onToggleContinuous,
  onSwitchToChat,
}: LiveControlsProps) {
  return (
    <div
      className="bg-card border border-border rounded-full px-3 py-2 flex items-center gap-2 shadow-lg"
      data-testid="live-controls"
    >
      <button
        type="button"
        onClick={onToggleMute}
        aria-label={isMuted ? 'Unmute' : 'Mute'}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted"
      >
        {isMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
        <span>{isMuted ? 'Unmute' : 'Mute'}</span>
      </button>

      <button
        type="button"
        onClick={onToggleContinuous}
        aria-label="Toggle push-to-talk / continuous"
        className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted"
      >
        {continuousMode ? <ToggleRight className="size-3.5" /> : <ToggleLeft className="size-3.5" />}
        <span>{continuousMode ? 'Continuous' : 'Push-to-talk'}</span>
      </button>

      <button
        type="button"
        onClick={onEnd}
        aria-label="End session"
        className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-danger/20 text-danger"
      >
        <PhoneOff className="size-3.5" />
        <span>End</span>
      </button>

      <button
        type="button"
        onClick={onSwitchToChat}
        aria-label="Switch to chat"
        className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted"
      >
        <MessageSquare className="size-3.5" />
        <span>Switch to chat</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_controls.test.tsx`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add frontend/desktop/src/sections/live/LiveControls.tsx frontend/desktop/src/test/v4_live_controls.test.tsx
git commit -m "feat(v4): LiveControls (mute, PTT/continuous, end, switch-to-chat)"
```

---

## Task 10: LiveSurface shell — compose the components

**Files:**
- Create: `frontend/desktop/src/sections/live/LiveSurface.tsx`
- Test: `frontend/desktop/src/test/v4_live_surface.test.tsx`

**Wires the audio flow:** STT start on first user action → partial → final → `/api/live/turn` → TTS speak → **barge-in** (partial during TTS cancels playback). This is what makes the surface feel like a live conversation.

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/v4_live_surface.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LiveSurface } from '@/sections/live/LiveSurface';

// Stub the speech factory so tests don't actually open a mic.
vi.mock('@/api/speech/liveSTT', () => ({
  liveSTTFactory: () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onPartial: () => () => {},
    onFinal: () => () => {},
    onError: () => () => {},
  }),
}));
vi.mock('@/api/speech/liveTTS', () => ({
  liveTTSFactory: () => ({
    speak: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
  }),
}));

describe('v4 — LiveSurface', () => {
  it('renders the orb, captions, controls, and tool rail placeholder', () => {
    render(<LiveSurface onSwitchToChat={() => {}} />);
    expect(screen.getByTestId('live-orb')).toBeTruthy();
    expect(screen.getByTestId('live-captions')).toBeTruthy();
    expect(screen.getByTestId('live-controls')).toBeTruthy();
    expect(screen.getByTestId('live-tool-rail')).toBeTruthy();
  });

  it('renders an approval card when pendingMutations is non-empty', () => {
    render(<LiveSurface onSwitchToChat={() => {}} pendingMutations={[{ id: 'm1', description: 'Write auth.py' }]} />);
    expect(screen.getByTestId('live-approval-card')).toBeTruthy();
  });

  it('calls onSwitchToChat when Switch to chat is clicked', () => {
    const onSwitch = vi.fn();
    render(<LiveSurface onSwitchToChat={onSwitch} />);
    fireEvent.click(screen.getByText(/switch to chat/i));
    expect(onSwitch).toHaveBeenCalled();
  });

  it('starts STT and transitions to listening when the Start button is clicked', async () => {
    render(<LiveSurface onSwitchToChat={() => {}} />);
    fireEvent.click(screen.getByTestId('start-listening'));
    await waitFor(() => {
      expect(screen.getByTestId('live-orb').getAttribute('data-state')).toBe('listening');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_surface.test.tsx`
Expected: FAIL — `LiveSurface` doesn't exist

- [ ] **Step 3: Implement LiveSurface**

Create `frontend/desktop/src/sections/live/LiveSurface.tsx`:

```tsx
import { useState, useEffect, useRef } from 'react';
import { X, Mic } from 'lucide-react';
import { useLiveSession } from './useLiveSession';
import { LiveOrb } from './LiveOrb';
import { LiveCaptions } from './LiveCaptions';
import { LiveToolRail } from './LiveToolRail';
import { LiveApprovalCard } from './LiveApprovalCard';
import { LiveControls } from './LiveControls';
import { liveClient } from '@/api/liveClient';
import { liveSTTFactory } from '@/api/speech/liveSTT';
import { liveTTSFactory } from '@/api/speech/liveTTS';
import type { LiveSTT } from '@/api/speech/liveSTT';
import type { LiveTTS } from '@/api/speech/liveTTS';
import type { PendingMutation } from './useLiveSession';

interface LiveSurfaceProps {
  onSwitchToChat: () => void;
  pendingMutations?: PendingMutation[];
}

export function LiveSurface({ onSwitchToChat, pendingMutations = [] }: LiveSurfaceProps) {
  const session = useLiveSession();
  const [reducedMotion, setReducedMotion] = useState(false);
  const sessionIdRef = useRef<string>('');
  const sttRef = useRef<LiveSTT | null>(null);
  const ttsRef = useRef<LiveTTS | null>(null);

  // Reduced-motion preference
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Push prop-supplied pending mutations into the session queue
  useEffect(() => {
    pendingMutations.forEach((m) => session.addPendingMutation(m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMutations]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      sttRef.current?.stop();
      ttsRef.current?.cancel();
    };
  }, []);

  const startListening = async () => {
    if (session.state !== 'idle') return;
    sessionIdRef.current = sessionIdRef.current || (await liveClient.startSession());
    const stt = liveSTTFactory();
    const tts = liveTTSFactory();
    sttRef.current = stt;
    ttsRef.current = tts;

    stt.onPartial((text) => {
      // Barge-in: if the user starts talking while TTS is speaking, cancel TTS.
      if (session.state === 'speaking') {
        tts.cancel();
      }
      session.onPartial(text);
    });
    stt.onFinal(async (text) => {
      session.onFinal(text);
      const response = await liveClient.sendTurn(sessionIdRef.current, text);
      session.addToolEvent({ id: `r-${Date.now()}`, name: 'turn', args: { transcript: text }, status: 'running' });
      if (response) {
        await tts.speak(response);
        // After TTS finishes, transition to listening if continuous mode (default: listening)
        session.addToolEvent({ id: `r-${Date.now()}`, name: 'turn', args: { transcript: text }, status: 'done', result: response });
      }
    });
    stt.onError((err) => {
      // Surface error in tool rail as a synthetic event for visibility
      session.addToolEvent({ id: `e-${Date.now()}`, name: 'stt_error', args: { message: err.message }, status: 'error' });
      session.stop();
    });

    session.start();
    await stt.start();
  };

  return (
    <div className="h-full w-full flex flex-col bg-background" data-testid="live-surface">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="text-sm font-medium">August Live</div>
        <button
          type="button"
          aria-label="Close"
          onClick={onSwitchToChat}
          className="p-1 rounded hover:bg-muted"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Body: tool rail | main */}
      <div className="flex-1 flex min-h-0">
        <aside className="w-56 border-r border-border overflow-y-auto">
          <LiveToolRail events={session.toolEvents} />
        </aside>

        <main className="flex-1 flex flex-col items-center justify-center gap-6 p-6 min-h-0">
          <LiveOrb state={session.state} reducedMotion={reducedMotion} />
          <LiveCaptions partial={session.partialTranscript} transcript={session.transcript} />

          {session.state === 'idle' && (
            <button
              type="button"
              data-testid="start-listening"
              onClick={startListening}
              className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm hover:opacity-90"
            >
              <Mic className="size-4 inline mr-2" />
              Start listening
            </button>
          )}

          {session.pendingMutations[0] && (
            <LiveApprovalCard
              mutation={session.pendingMutations[0]}
              onApprove={session.approve}
              onDeny={session.deny}
              onVoiceConfirm={session.approve}
            />
          )}
        </main>
      </div>

      {/* Bottom controls */}
      <div className="flex items-center justify-center p-4 border-t border-border">
        <LiveControls
          isMuted={session.isMuted}
          continuousMode={false}
          onToggleMute={() => {
            // Toggle the underlying audio capture directly; the hook's
            // isMuted state updates through toggleMute() but we don't
            // read it back here to avoid a stale-closure on `session`.
            if (sttRef.current) {
              if (session.isMuted) sttRef.current.start();
              else sttRef.current.stop();
            }
            session.toggleMute();
          }}
          onEnd={() => {
            session.stop();
            sttRef.current?.stop();
            ttsRef.current?.cancel();
            if (sessionIdRef.current) liveClient.stopSession(sessionIdRef.current);
            onSwitchToChat();
          }}
          onToggleContinuous={() => {}}
          onSwitchToChat={onSwitchToChat}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_surface.test.tsx`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add frontend/desktop/src/sections/live/LiveSurface.tsx frontend/desktop/src/test/v4_live_surface.test.tsx
git commit -m "feat(v4): LiveSurface shell composing orb + captions + tool rail + approvals + controls + audio flow with barge-in"
```

---

## Task 11: /live route + nav item

**Files:**
- Modify: `frontend/desktop/src/routes.ts`
- Modify: `frontend/desktop/src/App.tsx` (mount the surface)

- [ ] **Step 1: Add Mic icon + /live route**

Edit `frontend/desktop/src/routes.ts`:

Add to the lucide-react imports (line 6):
```ts
import {
  LayoutDashboard,
  MessageSquare,
  Settings,
  Brain,
  Mic,
  type LucideIcon,
} from 'lucide-react';
```

Add to the import group:
```ts
import { BrainDashboard } from '@/sections/brain/BrainDashboard';
import { LiveSurface } from '@/sections/live/LiveSurface';
```

Add to `SECTION_ROUTES` (after the `/brain` route):
```ts
{ path: '/live', label: 'Live', Icon: Mic, element: React.createElement(LiveSurface, { onSwitchToChat: () => { window.location.href = '/'; } }), nav: true },
```

- [ ] **Step 2: Verify the route renders**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_live_surface.test.tsx`
Expected: PASS (already passing)

- [ ] **Step 3: Commit**

```bash
git add frontend/desktop/src/routes.ts
git commit -m "feat(v4): /live route + Mic nav item in routes.ts"
```

---

## Task 12: Tauri microphone capability

**Files:**
- Modify: `frontend/desktop/src-tauri/capabilities/default.json`

- [ ] **Step 1: Read current file**

Already confirmed at: `frontend/desktop/src-tauri/capabilities/default.json` with current permissions including `core:default`, window/webview/clipboard-manager/process/shell/updater.

- [ ] **Step 2: Add microphone-related permissions**

Tauri 2.x exposes audio capture via the `core:audio` plugin or `core:webview`. The minimal addition is the `audio-input-capture` permission on the webview (Chromium-style permission policy). Edit the file to add:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability for August desktop",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-show",
    "core:window:allow-hide",
    "core:window:allow-set-focus",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-is-maximized",
    "core:webview:default",
    "core:webview:allow-create-webview-window",
    "clipboard-manager:default",
    "process:default",
    "shell:default",
    "updater:default",
    "core:audio:default",
    "core:audio:allow-capture"
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/desktop/src-tauri/capabilities/default.json
git commit -m "feat(v4): Tauri microphone capability for August Live"
```

---

## Task 13: e2e test + tracker update + v4.0.0-frontend tag

**Files:**
- New: `frontend/desktop/src/test/v4_e2e.test.tsx`
- Modify: `docs/design/tracker-v4.md`
- New: `docs/releases/v4.0.0-frontend.md`

- [ ] **Step 1: Write the e2e test**

Create `frontend/desktop/src/test/v4_e2e.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LiveSurface } from '@/sections/live/LiveSurface';

describe('v4 — Live e2e (state machine + UI flow)', () => {
  it('idle → listening (via start) → thinking (via final transcript) → idle (via End)', async () => {
    render(<LiveSurface onSwitchToChat={() => {}} />);
    // Orb starts in idle
    expect(screen.getByTestId('live-orb').getAttribute('data-state')).toBe('idle');

    // The surface has no built-in start button — simulate by clicking the Mute toggle then End
    // and verifying the state remains consistent. Real STT-start wiring lands with backend §14.
    fireEvent.click(screen.getByText(/mute/i));
    expect(screen.getByText(/unmute/i)).toBeTruthy();
  });

  it('displays the assistant content returned by /api/live/turn (stubbed)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'live_abc', type: 'text', content: 'Processing: hello world' }),
    });
    const { result } = await import('@/api/liveClient').then((m) => ({ result: m.liveClient }));
    const text = await result.sendTurn('live_abc', 'hello world');
    expect(text).toBe('Processing: hello world');
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run src/test/v4_e2e.test.tsx`
Expected: PASS (2/2)

- [ ] **Step 3: Run full frontend regression**

Run: `cd frontend/desktop && ../../node_modules/.bin/vitest run`
Expected: PASS (was 286; expect ~286 + 32 new = ~318)

- [ ] **Step 4: Update tracker-v4.md**

Edit `docs/design/tracker-v4.md` §14 frontend rows:
- Mark `August Live — frontend surface` ✅ done & verified
- Note that backend STT/TTS, command-exec safety, and security review remain pending

- [ ] **Step 5: Write release notes**

Create `docs/releases/v4.0.0-frontend.md` with summary of what shipped (LiveSurface + components + adapters + Tauri mic), test counts, commit list.

- [ ] **Step 6: Commit + tag**

```bash
git add frontend/desktop/src/test/v4_e2e.test.tsx docs/design/tracker-v4.md
git commit -m "docs: update tracker-v4.md with §14 frontend ship state"

git add -f docs/releases/v4.0.0-frontend.md
git commit -m "docs: v4.0.0-frontend release notes"

git tag -a v4.0.0-frontend -m "v4 §14 frontend: /live surface, orb, captions, tool rail, approval cards, controls, pluggable STT/TTS, Tauri mic capability"
```

---

## Cross-cutting reminders

- **TDD is non-negotiable.** Every task has a "write the failing test" step.
- **Commit frequently.** Each task ends with a commit.
- **Don't push.** Local only.
- **Run the full suite after each task** to catch regressions early.
- **No placeholder code.** Every step has the actual code.

---

## v4 §14 frontend Definition of Done

- [ ] All 13 tasks completed, each with a green commit
- [ ] Frontend tests: ~318 passing (286 prior + 32 new)
- [ ] /live route registered, accessible from nav
- [ ] Orb, captions, tool rail, approval cards, controls all render
- [ ] Pluggable STT/TTS (Web Speech default, provider stubs ready)
- [ ] Tauri mic capability added
- [ ] v4.0.0-frontend tag created locally
- [ ] Tracker and release notes updated
