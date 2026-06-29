# Implementation Tracker — v4 (August Live + UI Redesign)

> **Spec:** [`cognitive-architecture-v1.md`](./cognitive-architecture-v1.md) — Sections 14, 15, 16
> **Scope:** A Gemini-Live-style voice mode that can execute commands (§14), a
> modern/minimalist UI redesign of the August chat + shell (§15), and three
> grounded rendering/input fixes — math typesetting, auto-grow composer, chat
> scroll thumb (§16).
> **Previous files:** [`tracker-v1.md`](./tracker-v1.md), [`tracker-v2.md`](./tracker-v2.md), [`tracker-v3.md`](./tracker-v3.md)

## Gate — do not start until

- [ ] [`tracker-v1.md`](./tracker-v1.md) complete & verified in production
- [ ] Workbench turn engine + SSE events stable (August Live reuses them, no new tool loop)
- [ ] Guard mode + pending-mutation approval working (Live inherits it verbatim)

> v4 depends on **v1** (turn engine, guard mode, brain access). It does **not**
> depend on v2/v3. §14 and §15 are independent of each other but share design
> tokens — if doing both, land §15 tokens first so August Live ships in the new look.

## Progress

| Section | Component | Status | Owner | Notes |
|--------:|-----------|--------|-------|-------|
| 16.1 | Math rendering (KaTeX) | ✅ done & verified | | katex installed, ChatMarkdown tokenizers, CSS sizing, currency guard |
| 16.2 | Composer auto-grow (value-driven) | ✅ done & verified | | useLayoutEffect keyed on input, onChange simplified |
| 16.3 | Chat scroll thumb (draggable) | ✅ done & verified | | .chat-scroll CSS, min-height 40px, 10px gutter |
| 15 | UI redesign — tokens (`styles.css`) | ✅ done & verified | | Light + dark retuned per spec. Body line-height 1.6. Type scale calmed. |
| 15 | UI redesign — chat bubble-less layout + composer | ☐ | | pending — bubble-less layout + centered column |
| 14 | August Live — backend (`live.py`) | ✅ done & verified | | session/turn/stt/tts endpoints. Reuses workbench turn engine. |
| 14 | August Live — STT/TTS adapters + config | ☐ | | provider-agnostic adapters |
| 14 | August Live — frontend surface (orb/captions/tool rail) | ☐ | | full-window /live route |
| 14 | August Live — command-exec safety (guard mode parity) | ☐ | | verify guard mode inherited |
| 14 | August Live — **mandatory security review** (gate) | ☐ | | hard gate before Live ships |

Status legend: ☐ not started · ◐ in progress · ✅ done & verified · ⚠ blocked

---

## Section 16 — Rendering & Input Fixes (quick wins, do early)

> Three grounded, self-contained fixes. Each has exact file + line + change in spec §16.
> Independent of §15/§14; safe to land first. No backend changes.

### 16.1 Math rendering (KaTeX)
- [ ] `npm i katex` + `npm i -D @types/katex` (frontend/desktop)
- [ ] Import `katex/dist/katex.min.css` in `src/main.tsx`
- [ ] In `ChatMarkdown.tsx`, register `marked` tokenizers for inline (`\( \)`, `$ $`) + display (`\[ \]`, `$$ $$`) math → `katex.renderToString({displayMode, throwOnError:false, output:'htmlAndMathml', strict:false})`
- [ ] `$`-guard so currency ("$5") isn't treated as math
- [ ] Code (inline + fenced) stays literal (tokenizer order); streaming only matches *closed* delimiters
- [ ] `.katex` / `.katex-display` sizing in `styles.css` (display block scrolls horizontally)
- [ ] Tests: inline + display render; `$5`/code literal; invalid LaTeX shows source in error color, no crash; mid-stream `$$` no flicker

### 16.2 Composer auto-grow (value-driven)
- [ ] In `ChatComposer.tsx`, extract `resizeTextarea()` and call from `useLayoutEffect` keyed on `input` (MIN_H 64 / MAX_H 360; toggle `overflowY` when over cap)
- [ ] Simplify `onChange` to `onInputChange(e.target.value)` only (remove inline height writes)
- [ ] Tests: paste long msg expands then scrolls; draft restore + `INSERT_COMPOSER_TEXT_EVENT` + queued-message restore all expand without a keystroke; send shrinks back to 1 row

### 16.3 Chat scroll thumb (draggable)
- [ ] In `ChatThread.tsx:1954`, remove scrollbar-hiding utilities → `className="flex-1 overflow-y-auto chat-scroll"`; delete stale comment at ~708
- [ ] Add `.chat-scroll` scrollbar rules in `styles.css` (theme-aware via `--dt-*`, `min-height:40px` thumb floor, 10px gutter)
- [ ] Tests: long chat shows draggable thumb never thinner than 40px; light/dark color correct; wheel + "scroll to bottom" + checkpoint `scrollIntoView` still work

### Definition of Done
Math typesets like handwritten notation; the composer grows for any input source and scrolls past 360px; the transcript has a usable, draggable scroll thumb in long conversations.

### Notes

---

## Section 15 — UI Redesign (do first)

> Token refinement, **not** a rewrite. The `--dt-*` indirection means most of the app
> re-skins by editing `styles.css`. No component API changes outside the listed files.

### Tasks — tokens
- [ ] Retune light `--dt-*` per spec (near-paper bg, calmer accent `#2f6df6`, muted status, light code blocks)
- [ ] Retune dark `--dt-*` per spec (true-neutral charcoal tiers, accent `#6f9bff`, inset code)
- [ ] Default theme = **dark** (keep light polished)
- [ ] Body line-height → 1.6; confirm `data-text-size` scaling still applies across new scale
- [ ] Type scale: Display/H1/H2/Body/Small/Mono/Label per spec table
- [ ] Secondary text uses `--dt-muted-foreground`; avoid pure black/white ink

### Tasks — layout
- [ ] `tailwind.config.cjs`: default radius `10px`, line-height tweak
- [ ] Chat column centered, max-width ~720–760px
- [ ] **Bubble-less turns:** caps role label + color differentiation, whitespace separation (no colored bubbles)
- [ ] Composer: single rounded `14px` field, hairline border, accent focus ring, embedded send + mic (mic → August Live §14), secondary actions behind `+`/`⋯`
- [ ] Code blocks: inset surface, JetBrains Mono 13.5px, hover copy button, language label
- [ ] Density toggle (Comfortable / Compact) mapping turn-gap + composer padding

### Files
`src/styles.css`, `tailwind.config.cjs`, chat thread + composer components only.

### Tests
- [ ] WCAG AA contrast for body/secondary on both themes (AAA primary on dark)
- [ ] Token swap → no component code changes outside listed files
- [ ] Bubble-less centered chat; code blocks inset + copy
- [ ] `data-text-size` scaling works; `prefers-reduced-motion` respected
- [ ] Light + dark visual review vs Claude Desktop / Codex / Z.code reference feel

### Definition of Done
The chat reads as calm, content-first prose in a centered column; dark theme matches the reference apps' feel; entire app re-skinned via tokens with no regressions.

### Notes

---

## Section 14 — August Live (Voice + Command Execution)

> Voice I/O shell around the **existing** workbench turn loop. No second brain.
> The command-execution safety model is the highest-risk part — review it explicitly.

### Tasks — backend
- [ ] New `app/routers/live.py`
- [ ] `POST /api/live/session` (reuses workbench session)
- [ ] `POST /api/live/turn` `{sessionId, transcript}` → runs **existing** workbench tool loop, streams same SSE events
- [ ] Optional server-side `POST /api/live/stt` and `POST /api/live/tts` (or frontend talks to provider directly)
- [ ] `GET/PUT /api/config/live` — STT/TTS provider+model+voice (`config.json → auxiliary.live`)
- [ ] Reasoning model = **Cortex** (no downgrade)

### Tasks — STT/TTS adapters
- [ ] STT adapter (provider-agnostic: Whisper/gpt-4o-transcribe/Deepgram/local + browser `SpeechRecognition` fallback)
- [ ] TTS adapter (OpenAI TTS/ElevenLabs/Piper + browser `speechSynthesis` fallback)
- [ ] Settings UI for STT/TTS provider/model/voice (parallel to Model Fleet subtab)

### Tasks — command-execution safety (REVIEW CAREFULLY)
- [ ] Guard mode applies **identically** to voice — no "voice bypass"
- [ ] Mutating tools → pending mutation; **dual-surfaced** approval (spoken prompt + visible card)
- [ ] Voice "confirm" → `POST /api/workbench/mutations/respond`; "stop"/"August stop" cancels
- [ ] Read-only tools (read_file, brain_query, web_fetch, list_directory, read-only run_command) run without gate
- [ ] Destructive verbs (per mutation classifier) never auto-run from voice
- [ ] Always-visible mute + verbal kill-switch halts capture + in-flight TTS immediately
- [ ] Every Live turn persisted to `messages` store (auditable, `brain_query`-able)

### Tasks — frontend surface (route `/live`)
- [ ] Animated orb/waveform reflecting state (idle/listening/thinking/speaking) via framer-motion
- [ ] Large rolling captions (partial ghosted → final committed)
- [ ] Tool activity rail: Live tool cards (name/args/running→done) + spoken narration
- [ ] Approval cards (Approve/Deny) co-located with spoken prompt
- [ ] Controls: Mute, End, push-to-talk vs continuous toggle, STT/TTS quick-pick, "switch to chat" handoff
- [ ] Reduced-motion orb variant; captions always on; voice actions also clickable
- [ ] Barge-in: mic speech during TTS pauses playback
- [ ] Tauri microphone capability added to `src-tauri/capabilities/default.json`

### Files
`app/routers/live.py` (new), `config.py` (live endpoints), frontend `/live` surface + STT/TTS clients + audio hooks, `src-tauri/capabilities/default.json`.

### Tests
- [ ] Final transcript drives a normal workbench turn (parity with typed input)
- [ ] Mutating voice command → pending mutation; spoken+visual approval; "confirm" approves, "stop" cancels
- [ ] Read-only tools run without gate; destructive verbs never auto-run
- [ ] Barge-in pauses TTS; mute halts capture immediately
- [ ] STT/TTS fall back to browser APIs when no provider configured
- [ ] Live turns persist to `messages` identically to typed turns

### Definition of Done
The user can hold a spoken conversation with August in a polished Live surface; August speaks, runs read-only tools freely, and executes mutations only through the same guard-mode approval as chat (spoken + visual). All turns are auditable in normal history.

### Notes

---

## Mandatory security review (HARD GATE — August Live must not ship without sign-off)

> August Live is the only surface where **voice can trigger `run_command`**. Run the
> `security-review` skill (`/security-review`) on the Live diff (`app/routers/live.py`
> + frontend audio/exec path + Tauri capability change) and record sign-off below.

- [ ] **No privilege delta vs chat** — Live enters the *same* `_execute_tool` / guard-mode / mutation-classifier path; no alternate execution path skips the gate (confirmed by code inspection)
- [ ] **No voice auto-confirm of mutations** — spoken "confirm" maps only to `mutations/respond`; destructive-verb set cannot be satisfied by transcription alone (tested with adversarial transcripts, e.g. a page read aloud saying "yes run it")
- [ ] **Transcript = untrusted input** — STT output treated exactly like typed text; no Live-specific unsanitized interpolation into commands
- [ ] **Kill-switch integrity** — mute / "stop" reliably halts capture; in-flight execution not bypassable by overlapping audio
- [ ] **Capability scope** — new Tauri mic capability grants mic only; does not widen shell/fs perms in `default.json`
- [ ] **Sign-off recorded:** reviewer + date: ____________________

### Notes

---

## v4 exit criteria
- [ ] Every box above checked
- [ ] §16: math typesets (not raw LaTeX); composer auto-grows for every input source; transcript has a draggable scroll thumb
- [ ] §15: app re-skinned via tokens, dark default, bubble-less chat, no regressions
- [ ] §14: voice parity with typed turns; guard-mode safety verified end-to-end; no voice bypass
- [ ] **Mandatory security review signed off** (section above) — August Live does not ship without it
- [ ] August Live ships in the new §15 visual language
- [ ] No regression to v1/v2/v3 chat loop
