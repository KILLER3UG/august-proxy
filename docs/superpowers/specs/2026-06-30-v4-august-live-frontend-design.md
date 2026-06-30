# v4 §14 — August Live Frontend Surface (Design)

**Date:** 2026-06-30
**Status:** Draft for review
**Scope:** Full-window `/live` route in the desktop app: animated orb, rolling captions, tool activity rail, approval cards, controls (mute / end / push-to-talk / handoff), Tauri mic capability. STT/TTS via a pluggable client (Web Speech API default + provider stubs). Backend integration hits the existing `/api/live/*` stubs.
**Reference:** `docs/design/cognitive-architecture-v1.md` §14, `docs/design/tracker-v4.md`.
**Out of scope this iteration:** real provider wiring, command-exec safety plumbing, mandatory security review (gate that lands with §14 backend).
**Previous files:** [`2026-06-29-v3-brain-dashboard-design.md`](2026-06-29-v3-brain-dashboard-design.md), [`tracker-v3.md`](../../design/tracker-v3.md).

---

## 1. Background

August Live is a Gemini-Live-style voice mode that wraps the existing workbench turn loop. The backend (`app/routers/live.py`, v4 §14) ships as a stub today — it returns `"Processing: <transcript>"` for `/turn`. The remaining §14 work splits cleanly:
- Backend wiring (real turn engine + provider-backed STT/TTS) — separate sub-project.
- **Frontend surface (this design)** — full-window `/live` UI that works in *shape* against the stub backend; when real backend lands, only the `liveClient` module changes.
- Security review — hard gate, covered when command-exec safety ships.

This design takes the frontend-only cut.

## 2. Goals and non-goals

### Goals
- New `/live` full-window route with a polished voice I/O surface
- Animated orb reflecting 4 states (idle / listening / thinking / speaking) via framer-motion
- Large rolling captions (partial → final committed)
- Tool activity rail: tool cards (name/args/running→done) + spoken narration badges
- Approval cards co-located with spoken prompt (visual + voice-confirm placeholder)
- Controls: Mute, End, push-to-talk vs continuous toggle, "switch to chat" handoff
- Pluggable STT/TTS client: Web Speech API default + provider stubs (interface ready for real providers)
- Barge-in: mic speech during TTS pauses playback
- Tauri microphone capability added to `src-tauri/capabilities/default.json`
- Reduced-motion orb variant
- All v4 visual language uses §15 tokens (already shipped)

### Non-goals
- No real provider integration (Whisper/ElevenLabs/etc.) — adapter stubs only
- No command-exec safety wiring (guard mode parity lands with backend §14)
- No security review (the hard gate)
- No transcript persistence (backend §14)

## 3. Component map

### New files
```
frontend/desktop/src/
  sections/live/
    LiveSurface.tsx          main shell (full-window layout)
    LiveOrb.tsx              animated orb + reduced-motion variant
    LiveCaptions.tsx         rolling captions (partial → final)
    LiveToolRail.tsx         tool activity cards
    LiveApprovalCard.tsx     in-surface approval card
    LiveControls.tsx         bottom controls row
    useLiveSession.ts        state machine hook
  api/
    liveClient.ts            REST/SSE client to /api/live/*
    speech/
      liveSTT.ts             SpeechService interface + Web Speech impl
      liveTTS.ts             SpeechService interface + Web Speech impl
      providerSTT.ts         provider adapter stub
      providerTTS.ts         provider adapter stub
  test/
    v4_live_surface.test.tsx
    v4_live_captions.test.tsx
    v4_live_tool_rail.test.tsx
    v4_live_controls.test.tsx
    v4_live_approval.test.tsx
    v4_speech_adapter.test.ts
```

### Modified files
```
frontend/desktop/src/
  App.tsx                    keep as-is (routes drive from /routes)
  routes.ts                  add /live route + nav item (Mic icon)
  api/ui-events.ts           dispatchStartLiveSession, dispatchEndLiveSession
  components/overlays/ApprovalBanner.tsx  expose useApprovalQueue() hook
src-tauri/capabilities/
  default.json               add microphone permission
```

## 4. State machine

The Live surface is fundamentally a state machine:

```
        ┌──── tap mic / push-to-talk ────┐
        ▼                                │
   ┌─────────┐    speech end    ┌─────────┐
   │  idle   │ ◀──────────────▶ │ listening│
   └─────────┘                 └─────────┘
        ▲                            │
        │ tap End                   │ commit transcript
        │                            ▼
        │                       ┌─────────┐
        │                       │ thinking │ ◀── turn loop emits events
        │                       └─────────┘
        │                            │
        │                            │ tool calls / approval needed
        │                            ▼
        │              ┌────────────────────┐
        │              │ tool-running or    │
        │              │ awaiting-approval  │
        │              └────────────────────┘
        │                            │
        │                            ▼
        │                       ┌─────────┐
        │                       │ speaking │
        └─────────────────────  └─────────┘
              tap End              (barge-in → listening)
```

The `useLiveSession` hook exposes `{state, transcript, partialTranscript, toolEvents, pendingMutations, start, stop, mute, approve, deny}`.

## 5. Backend contract

Hits the existing stub endpoints in `app/routers/live.py`:
- `POST /api/live/session { action: 'start' | 'stop' }` → `{ sessionId }`
- `POST /api/live/turn { sessionId, transcript }` → `{ sessionId, type: 'text', content }` (returns the stub's "Processing: …" placeholder)
- `POST /api/live/stt { audio: Blob }` → `{ transcript, partial }` (stub returns empty)
- `POST /api/live/tts { text, voice }` → `{ audio, format }` (stub returns null)

For shape testing, the frontend uses:
- Web Speech API for STT/TTS in the browser (no provider config needed)
- `/api/live/turn` for the assistant turn (the stub gives a real response shape)
- `/api/live/session` to start/stop a session

When the real backend (§14 backend sub-project) lands, only `liveClient.ts` changes — UI contracts are stable.

## 6. Pluggable STT/TTS client

```ts
// api/speech/liveSTT.ts
export interface LiveSTT {
  start(): Promise<void>;
  stop(): Promise<void>;
  onPartial(callback: (text: string) => void): () => void;
  onFinal(callback: (text: string) => void): () => void;
  onError(callback: (err: Error) => void): () => void;
}
```

Two implementations:
- `WebSpeechSTT` — wraps `window.SpeechRecognition` (Chromium browsers). Default if no provider is configured.
- `ProviderSTT` — stub that hits `/api/live/stt`. Will be replaced with real provider calls in §14 backend cut.

Same pattern for TTS (`WebSpeechTTS` + `ProviderTTS`). The default factory picks Web Speech when available, otherwise falls back to provider stubs.

## 7. UI surface

### 7.1 Layout (`/live` route, full-window)

```
┌──────────────────────────────────────────────────────────────┐
│  [X] close                  August Live         [⋯ settings]  │
│                                                              │
│  ┌──── tool rail ────┐                                       │
│  │  🛠 read_file     │                                       │
│  │  🛠 brain_query   │        ╭─────╮                         │
│  │       (collapsible)        │  ●  │      ← orb             │
│  │                          ╰─────╯                          │
│  │                          state: listening                 │
│                                                              │
│           "Reading auth.py now…"  (rolling captions)         │
│                                                              │
│                                                              │
│                                                              │
│  ╭─ controls ──────────────────────────────────────────╮     │
│  │ [🎤 mute] [▶ push-to-talk] [🏁 end] [⌨ switch to chat]│   │
│  ╰────────────────────────────────────────────────────╯     │
└──────────────────────────────────────────────────────────────┘
```

When a mutation needs approval:
```
              ┌─────────────────────────┐
              │ ⚠  Allow writing auth.py │
              │ ┌─spoken─ "may I…?"       │
              │ └─approve / deny         │
              └─────────────────────────┘
```

### 7.2 Reduced-motion
Orb becomes a static ring with a state label. Captions still animate (text-only transitions are OK).

### 7.3 Tauri mic capability
Add `microphone: 'audio-capture'` to `src-tauri/capabilities/default.json`. Existing `fs`, `shell` perms unchanged.

## 8. Accessibility & safety

- Captions always rendered (text alternative)
- All voice actions also clickable (Mute, End, Approve, Deny are buttons)
- `aria-live="polite"` on captions, `aria-live="assertive"` on approval cards
- `prefers-reduced-motion` respected (orb static, captions text-only)
- Mic permission denied → surface clear error + fallback to push-to-talk button
- No auto-confirm of mutations (no spoken "yes" auto-path that POSTs mutations/respond; that's the security review gate's concern)

## 9. Testing strategy

Frontend (Vitest):
- `v4_live_surface.test.tsx` — state transitions in the hook, orb renders the correct state class, controls fire callbacks
- `v4_live_captions.test.tsx` — partial → final commit lifecycle
- `v4_live_tool_rail.test.tsx` — tool events render and transition running→done
- `v4_live_controls.test.tsx` — Mute toggles isListening, End calls stop, push-to-talk toggles continuous mode
- `v4_live_approval.test.tsx` — approval card renders mutation, approve/deny fire callbacks, voice-confirm is a button (no spoken path yet)
- `v4_speech_adapter.test.ts` — interface conformance for Web Speech stub (skips browser, tests dispatch logic)

All vitest; no backend changes; backend stub assertions are limited to "POST /turn returns content → we render it".

Backend e2e (deliberately minimal): the existing `/api/live/turn` stub returns a usable response; we'll wire one optional test that hits it via `fetch`.

## 10. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Web Speech API not available in test env | High | Low | Stub interface; tests use mocked `SpeechRecognition` |
| Orb animation hooks fire in tests | Low | Low | framer-motion respects `prefers-reduced-motion`; tests bypass with state-based assertions |
| Tauri mic capability blocks browser dev | Medium | Medium | Capability is opt-in; dev mode uses browser getUserMedia |
| /api/live/turn stub returns no `sessionId` | Low | Low | liveClient normalizes response; missing fields → empty string |

## 11. Definition of Done

- All v4 frontend components ship, registered at `/live`, accessible from the main nav
- Each Vitest test passes
- No regression to chat / Brain / Exam surfaces
- Backend contract is unchanged from this design (liveClient is swappable)
- Reduced-motion variant verified manually
- Tracker `tracker-v4.md` §14 frontend row updated to ✅

## 12. Out of scope (next v4.x cut)

- Real provider integration (Whisper / Deepgram / ElevenLabs / Piper)
- Command-exec safety (voice-confirm → POST mutations/respond)
- Mandatory security review (hard gate before August Live ships)
- Live transcript persistence to `messages` store

---

**End of design doc. After your review, I'll write the implementation plan.**
