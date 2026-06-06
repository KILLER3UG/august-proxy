# Design: August Voice Assistant — Wake Word + Speech Interface

## Context

The proxy has a complete set of tools (Google services, GitHub, filesystem, MCP servers) accessible via REST API and AI model. Currently all interaction is text-based through Claude Code or the UI. This spec adds voice interaction — saying "August" activates the assistant and supports natural language commands backed by the full proxy AI + tooling.

## Architecture

Two modes, same backend (the proxy's existing `/v1/messages` API):

- **Browser mode** — lightweight, lives in the dashboard tab, zero install
- **Desktop mode** — always-on system tray app, replaces browser mode when ready

Both modes POST to the proxy's existing API endpoint. The proxy already handles: AI model routing, tool execution, memory context, and multi-turn conversation. No backend changes needed.

## Browser Mode

### Wake Word
- Continuous `webkitSpeechRecognition` (Chrome-based browsers) with `continuous: true`
- Runs in a dedicated Web Worker or polling loop
- On detecting "August" in the transcript, signals activation

### Activation
- A floating microphone button on the dashboard (bottom-right, above the debug/sidebar area)
- States: "listening" (idle), "active" (processing), "speaking" (responding)
- Clicking the button toggles listening on/off
- On wake word: brief audio cue (short beep/haptic), visual pulse animation

### Speech-to-Text
- Browser's built-in `SpeechRecognition` API (free, zero API keys)
- Language: `en-US`
- Interim results shown in a small transcript bubble
- On speech end (paused >1.5s), auto-submit to the proxy

### AI Processing
- `POST /v1/messages` with `model: claude-opus-4-7` and the transcribed text
- Streams the response back as text
- The proxy's context includes August Brain, all MCP tool definitions, and custom skills

### Text-to-Speech
- Browser `SpeechSynthesis` API
- Reads the AI response aloud
- Skip TTS for short confirmations ("Done", "Okay")

### UI Elements (all in a single floating panel)
1. Mic button — circle, pulse animation when listening
2. Transcript bubble — shows what you said
3. Response bubble — shows AI response text
4. Status indicator — idle/listening/processing/speaking

## Desktop Mode (future, note for reference)

- **Python tray app** using `pystray` + `pvporcupine` (Picovoice) for wake word
- "August" trained as custom wake word via Picovoice Console (free tier allows 1 custom)
- Speech-to-Text via `whisper.cpp` or `faster-whisper` (local, no API key)
- TTS via `edge-tts` (free, natural voices)
- System tray: green icon = listening, red = idle
- Sends to `POST http://localhost:8085/v1/messages`
- When desktop mode is built, browser mic can be removed

## Implementation Plan

### Phase 1: Browser Mode (single file, no backend changes)
- **File:** `ui/js/voice.js` — all wake word, STT, TTS, and UI logic
- **File:** `ui/partials/voice.html` — floating mic panel HTML
- **Modify:** `ui/pages/ui.html` — add include
- **Modify:** `ui/partials/scripts.html` — add script
- **Modify:** `ui/css/styles.css` — voice panel styles

### Phase 2: Desktop Mode (separate project)
- New Python project in `apps/voice-assistant/`
- Only built after Phase 1 is verified

## Verification

1. Open `http://localhost:8085/` — floating mic button visible bottom-right
2. Click mic — listening starts, shows "Listening..." tooltip
3. Say "August, list my Google calendars" — wakes up, transcribes, sends to proxy
4. Calendar data returns, TTS reads it aloud
5. Click mic again — stops listening
6. Verify no regression on existing dashboard functionality
