# Voice-Command → UI Infrastructure Design

**Date:** 2026-06-30  
**Status:** Draft  
**Feature:** Voice-Command → UI Infrastructure (with /model end-to-end)

## Overview

Enable users to trigger slash commands via voice input. When the user speaks a phrase matching a known voice trigger (e.g., "switch model"), August recognizes it as a command and renders the appropriate inline UI surface in the chat thread (e.g., a model picker card).

**Key principle:** Voice is an input modality, not a separate system. A spoken "switch model" is functionally identical to typing "/model" — same handler, same UI surface, same outcome.

**Scope:** Voice infrastructure + all currently-wired slash commands get voice triggers + working /model slash command (which is currently a no-op).

**Out of scope:** LiveSurface (full-window voice mode) is a separate workstream. This spec focuses on voice commands within the existing chat thread context.

## Goals

1. **Enable voice-driven command execution** — User says "switch model", August shows a model picker inline in the chat thread.
2. **Voice as alias for slash commands** — Voice phrases map to existing slash commands. Reuse dispatch logic, reuse UI surfaces.
3. **All current slash commands voice-enabled** — `/model`, `/help`, `/new`, `/clear`, `/load`, `/skills`, `/btw`, `/exam` all gain voice triggers.
4. **Working /model slash command** — Currently `/model` falls through to backend with no handler. This spec adds a real inline model picker.
5. **No server changes** — Pure frontend. Existing `/api/models` endpoint already serves the data the picker needs.

## Non-Goals

- Argument extraction from voice transcripts (e.g., "switch to claude-opus") — v1 ignores arguments, only intent matters. Future enhancement.
- Always-on wake word — v1 uses the existing push-to-talk Mic button in ChatComposer. No always-on listening.
- Server-side intent parsing — v1 is client-only for speed and simplicity.
- Voice commands in LiveSurface (full-window voice mode) — separate workstream; infrastructure designed to be reusable there.
- TTS responses to voice commands — v1 is silent; picker card appears, no audio feedback.

## Architecture

### Data Flow

```
User clicks Mic button in ChatComposer
  ↓
Web Speech API starts (or ProviderSTT fallback)
  ↓
User says "switch model"
  ↓
STT onFinal transcript: "switch model"
  ↓
VoiceCommandHandler.matchIntent(transcript) → ChatCommand | null
  ↓
[Match found] → dispatchVoiceCommand(command, args, context)
  ↓
Invokes the slash command handler (e.g., /model handler)
  ↓
Handler sets modelPickerActive state, mounts ModelPickerCard
  ↓
User picks a model from the card
  ↓
Model switches (existing logic: setSelectedModel + onSetSessionModel)
  ↓
Card dismisses
```

```
[No match] → transcript falls through to existing composer text behavior
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **`intent.ts`** | Pure function `matchIntent(transcript: string): ChatCommand \| null`. Tokenizes, normalizes, scores against each command's `voiceTriggers[]`. Returns highest-scoring match above threshold. |
| **`dispatch.ts`** | `dispatchVoiceCommand(command, args, context)`. Maps each command name to its slash handler; invokes it. |
| **`ModelPickerCard.tsx`** | Inline model picker card. Fetches models via `useModels()` + `useProviderAvailability()`. Renders grouped-by-provider list. On click: switches model + dismisses. |
| **`ChatThread.tsx`** | Houses slash command dispatcher. Adds `/model` handler (sets `modelPickerActive`, mounts `ModelPickerCard`). Integrates voice dispatch. |
| **`ChatComposer.tsx`** | Routes final STT transcript through `matchIntent`. Matched → dispatch as command. Unmatched → existing "append to composer" behavior. |
| **`commands-data.ts`** | Source of truth for slash commands. Extends `ChatCommand` interface with `voiceTriggers?: string[]`. Lists voice triggers for all commands. |

### File Structure

**New files:**
- `frontend/desktop/src/api/voice/intent.ts`
- `frontend/desktop/src/api/voice/dispatch.ts`
- `frontend/desktop/src/sections/chat/ModelPickerCard.tsx`
- `frontend/desktop/src/api/voice/intent.test.ts`
- `frontend/desktop/src/api/voice/dispatch.test.ts`
- `frontend/desktop/src/sections/chat/ModelPickerCard.test.tsx`

**Modified files:**
- `frontend/desktop/src/sections/chat/commands-data.ts`
- `frontend/desktop/src/sections/chat/ChatThread.tsx`
- `frontend/desktop/src/sections/chat/ChatComposer.tsx`
- `frontend/desktop/src/test/help_command_panel.test.tsx` (extend to cover voice path)

**No server changes.**

## Voice Intent Grammar

### Schema Extension

Extend the `ChatCommand` interface in `commands-data.ts`:

```typescript
interface ChatCommand {
  // existing fields
  name: string;
  desc: string;
  usage?: string;
  example?: string;
  category: string;
  
  // new field
  voiceTriggers?: string[];
}
```

### Voice Triggers (v1)

Each command gets a list of natural-language phrases (lowercase) that should trigger it:

| Slash Command | Voice Triggers |
|---------------|----------------|
| `/model` | `["switch model", "change model", "use a different model", "select a model"]` |
| `/help` | `["what can you do", "show commands", "list commands", "help"]` |
| `/clear` | `["clear chat", "start over", "clear the chat"]` |
| `/new` | `["new chat", "new conversation", "start a new chat"]` |
| `/load` | `["load session", "open session"]` |
| `/skills` | `["show skills", "list skills", "what skills"]` |
| `/btw` | `["by the way"]` |
| `/exam` | `["start exam", "open exam"]` |

**Future commands** (listed in `commands-data.ts` but fall through today): `/provider`, `/reset`, `/debug`, `/goal` — can be voice-enabled when their handlers are implemented. This spec leaves them as-is.

### Matching Algorithm

Implemented in `intent.ts` as a pure function:

```typescript
export function matchIntent(transcript: string): ChatCommand | null
```

**Algorithm:**
1. **Normalize:** lowercase, strip punctuation, collapse whitespace.
2. **Tokenize:** split on whitespace → array of tokens.
3. **Score each command:**
   - For each command with `voiceTriggers`, check each trigger phrase.
   - Score by:
     - **Exact substring match:** if trigger is a substring of transcript (or vice versa), score += 2.
     - **Token overlap:** count tokens in common, score += (overlap count / max(trigger tokens, transcript tokens)).
   - Command's final score = max score across its triggers.
4. **Threshold:** commands with score < 0.6 are discarded.
5. **Return:** highest-scoring command above threshold; `null` if none.

**Example matches:**
- Transcript: `"switch model"` → `/model` (exact substring match, score = 2)
- Transcript: `"can you switch the model please"` → `/model` (tokens: "switch", "model" overlap with trigger "switch model", score ≈ 0.8)
- Transcript: `"tell me a joke"` → `null` (no overlap with any trigger)
- Transcript: `"help"` → `/help` (exact match)

**Ambiguity handling:** If two commands score within ε = 0.1 of each other, pick the one with more exact token overlap. If still tied, pick the first in the `COMMANDS` array. Document this rule in tests.

### No Argument Extraction (v1)

Voice triggers in v1 only capture **intent**, not arguments. E.g., "switch to claude-opus" matches `/model` intent, but the "claude-opus" argument is ignored — the user still picks from the full model list.

**Future enhancement:** Extend `matchIntent` to return `{ command: ChatCommand, args: string }` and parse arguments via regex or NLU. Out of scope for v1.

## Component Design: ModelPickerCard

### Visual Design

```
┌─ Pick a model ────────────────────── × ┐
│  anthropic                              │
│    claude-opus-4-7     200k ctx   FREE  │
│    claude-sonnet-4-5   200k ctx         │
│  openai                                 │
│    gpt-4o              128k ctx         │
│    o1-preview          200k ctx         │
│  minimax                                │
│    minimax-m2.7        32k ctx    FREE  │
│  ...                                    │
└────────────────────────────────────────┘
```

**Mirrors `CommandHelpCard` visual language:**
- `Card` + `CardHeader` + `CardContent` from `@/components/ui/card`
- Tailwind utilities, dark mode by default
- Badge for context window, "FREE" badge for free models (derived from `isFree` field)

### Props

```typescript
interface ModelPickerCardProps {
  sessionId: string;
  onDismiss: () => void;
  onModelSelected?: (model: AggregatedModel) => void;
}
```

### Data Sources

- `useModels()` → fetches `/api/models` (aggregated models from custom `providers.json`)
- `useProviderAvailability()` → fetches `/api/config/activeProvider` (filters by `isAvailable`)
- Filters: only show models from available providers

### Grouping

Models are grouped by `provider` (e.g., "anthropic", "openai", "minimax"). Each provider is a section header; models are rows below it.

**Alternate grouping:** If the user has configured cognitive roles (cortex/cerebellum/hippocampus/prefrontal via `model_fleet.py`), group by role instead. Check `settings` for `auxiliary.model_fleet` config. V1 defaults to provider grouping; role grouping is a nice-to-have if time permits.

### Click Behavior

```typescript
const handleModelClick = (model: AggregatedModel) => {
  setSelectedModel(model);
  onSetSessionModel(sessionId, model.id, model.provider);
  onModelSelected?.(model);
  onDismiss();
};
```

Reuses the existing model-switching logic from `ChatComposer.tsx:296-398` (the dropdown).

### Empty State

If `models.length === 0` (no available models):

```
┌─ Pick a model ────────────────────── × ┐
│  No models available.                   │
│  Add a provider in Settings to see      │
│  available models.                       │
│                                          │
│  [Go to Settings →]                      │
└────────────────────────────────────────┘
```

### Accessibility

- Keyboard navigation: arrow keys to move between model rows, Enter to select
- ARIA: `role="listbox"`, `aria-labelledby` for the header, `role="option"` for each model row
- Focus trap: dismiss on Escape, focus returns to composer

## Integration Points

### ChatThread.tsx — /model Handler

Add to the slash command dispatcher (`ChatThread.tsx:1178-1281`):

```typescript
case 'model': {
  // New handler for /model slash command
  setModelPickerActive(true);
  // Optionally: push a { role: 'assistant', kind: 'model-picker' } message into the thread
  // so the picker persists in chat history (like /help CommandHelpCard)
  const pickerMessage: ChatMessage = {
    id: generateId(),
    role: 'assistant',
    content: '',
    kind: 'model-picker',
    timestamp: Date.now(),
  };
  setMessages(prev => [...prev, pickerMessage]);
  persistSession();
  setInputText('');
  break;
}
```

**Rendering:** Add a case to the message renderer (around `ChatThread.tsx:2337-2343` where `kind === 'help'` is handled):

```typescript
if (message.kind === 'model-picker') {
  return <ModelPickerCard sessionId={sessionId} onDismiss={handleDismissModelPicker} />;
}
```

**State:** Add `const [modelPickerActive, setModelPickerActive] = useState(false);` if needed (or rely on the message-in-thread pattern, which is cleaner).

### ChatComposer.tsx — Voice Transcript Routing

Modify the `onFinal` callback in the STT integration (currently around `ChatThread.tsx:1485-1532`):

```typescript
const handleVoiceFinal = (transcript: string) => {
  // NEW: try to match as a voice command
  const matchedCommand = matchIntent(transcript);
  
  if (matchedCommand) {
    // Dispatch as a command (same as if user typed the slash command)
    dispatchVoiceCommand(matchedCommand, transcript, { sessionId, messages, setMessages, /* ... */ });
    // Clear the composer input (voice command is silent in chat history per user decision)
    setInputText('');
    return;
  }
  
  // EXISTING: if no match, append transcript to composer as dictation
  setInputText(prev => prev + (prev ? ' ' : '') + transcript);
};
```

### commands-data.ts — Voice Triggers

Extend the existing `COMMANDS` array:

```typescript
export const COMMANDS: ChatCommand[] = [
  {
    name: '/help',
    desc: 'Show available commands',
    usage: '/help [command]',
    example: '/help model',
    category: 'General',
    voiceTriggers: ['what can you do', 'show commands', 'list commands', 'help'],
  },
  {
    name: '/model',
    desc: 'Switch model for this session',
    usage: '/model',
    example: '/model',
    category: 'Provider',
    voiceTriggers: ['switch model', 'change model', 'use a different model', 'select a model'],
  },
  {
    name: '/clear',
    desc: 'Clear the current conversation',
    usage: '/clear',
    example: '/clear',
    category: 'General',
    voiceTriggers: ['clear chat', 'start over', 'clear the chat'],
  },
  {
    name: '/new',
    desc: 'Start a new conversation',
    usage: '/new',
    example: '/new',
    category: 'General',
    voiceTriggers: ['new chat', 'new conversation', 'start a new chat'],
  },
  {
    name: '/load',
    desc: 'Load a previous session',
    usage: '/load <session-id>',
    example: '/load abc123',
    category: 'General',
    voiceTriggers: ['load session', 'open session'],
  },
  {
    name: '/skills',
    desc: 'Manage skills',
    usage: '/skills [list|install|remove]',
    example: '/skills list',
    category: 'Advanced',
    voiceTriggers: ['show skills', 'list skills', 'what skills'],
  },
  {
    name: '/btw',
    desc: 'Add context without interrupting flow',
    usage: '/btw <note>',
    example: '/btw I prefer Yarn over NPM',
    category: 'Advanced',
    voiceTriggers: ['by the way'],
  },
  {
    name: '/exam',
    desc: 'Open exam mode for a topic or attached files',
    usage: '/exam [topic]',
    example: '/exam python decorators',
    category: 'Study',
    voiceTriggers: ['start exam', 'open exam'],
  },
  // ... other commands (provider, reset, debug, goal) remain unwired for now
];
```

## Error Handling & Edge Cases

### No Match

**Scenario:** User says "tell me a joke" (no matching voice trigger).

**Behavior:** `matchIntent` returns `null`. Transcript falls through to existing "append to composer" behavior. User can send it as a regular message.

**No special error handling needed.**

### Ambiguous Match

**Scenario:** Two commands score within ε = 0.1 of each other.

**Resolution:** Pick the one with more exact token overlap. If still tied, pick the first in the `COMMANDS` array. Document this rule in `intent.test.ts`.

**Example:** Transcript "help me clear the chat" might match both `/help` and `/clear`. Tokenize and score; `/clear` has "clear the chat" as a trigger (exact match), so it wins.

### /model with No Available Models

**Scenario:** User triggers `/model` but `useModels()` returns an empty array (no providers configured, or all providers are down).

**Behavior:** `ModelPickerCard` renders an empty state:

```
┌─ Pick a model ────────────────────── × ┐
│  No models available.                   │
│  Add a provider in Settings to see      │
│  available models.                       │
│                                          │
│  [Go to Settings →]                      │
└────────────────────────────────────────┘
```

Button links to `/settings/providers`.

### STT Failure

**Scenario:** Web Speech API errors (e.g., no microphone permission, network timeout).

**Behavior:** Existing `onError` handler in `WebSpeechSTT.tsx` toasts an error. No change needed.

### Multiple Intents in One Transcript

**Scenario:** User says "switch model and clear chat".

**Behavior (v1):** `matchIntent` returns the first/highest-scoring match (e.g., `/model`). The "clear chat" part is ignored.

**Future enhancement:** Parse multiple intents and execute sequentially. Out of scope for v1.

### Model Switch Fails

**Scenario:** User picks a model, but the provider is down or the API key is invalid.

**Behavior:** The existing model-switch error path applies. Currently this is a toast or inline error in the chat. No change needed for voice commands.

### ProviderSTT Mode

**Scenario:** User is in a non-Chromium environment where Web Speech API is unavailable. `ProviderSTT` is used instead (records audio, posts to `/api/live/stt`).

**Behavior:** `/api/live/stt` is currently a stub returning `{transcript:"", partial:true}`. This spec does NOT implement real server-side STT. `ProviderSTT` will work once the server endpoint is wired (separate task). For v1, voice commands only work with Web Speech API (Tauri WebView2 = Chromium = supported).

**Future enhancement:** Wire up `/api/live/stt` to OpenAI Whisper or provider STT API.

## Testing Strategy

### Unit Tests

**`intent.test.ts`** — Voice intent matching:
- Exact match: `"switch model"` → `/model`
- Fuzzy match: `"can you switch the model please"` → `/model`
- No match: `"tell me a joke"` → `null`
- Ambiguity: `"help me clear"` → `/clear` (higher token overlap)
- Edge: empty string → `null`
- Edge: only punctuation `"!!!"` → `null`

**`dispatch.test.ts`** — Voice command dispatch:
- Each command name maps to correct handler
- Unknown command → no-op (shouldn't happen if `matchIntent` works)
- Handler receives correct context (sessionId, messages, etc.)

### Component Tests

**`ModelPickerCard.test.tsx`**:
- Renders list of models from `useModels()` mock
- Groups by provider
- Click row invokes `onModelSelected` callback
- Dismiss button invokes `onDismiss` callback
- Empty state when no models
- "FREE" badge appears on free models

### Integration Tests

**`ChatThread.test.tsx`** (extend existing):
- `/model` typed → `modelPickerActive` true, `ModelPickerCard` mounted
- Voice transcript "switch model" → same path as `/model` typed
- `/clear` voice → messages cleared
- `/help` voice → `CommandHelpCard` mounted (existing test already covers `/help` slash; just add voice path)

**`help_command_panel.test.tsx`** (extend):
- Voice transcript "what can you do" → `/help` card appears

### E2E Tests (if Playwright/Spectron setup exists)

- Click mic button
- Simulate STT transcript "switch model"
- Assert `ModelPickerCard` appears in thread
- Click a model row
- Assert session model updates
- Assert card dismisses

**If E2E setup does not exist:** Component + integration tests are sufficient for v1.

## Migration & Rollout

**No server rollout needed.** Pure frontend change.

**No database migration.** No config.json changes.

**Breaking changes:**
- `/model` slash command was previously a no-op (fell through to backend, which had no handler). It now opens an inline model picker. Tiny breaking change for any user who had been typing `/model` and expecting nothing to happen. Net positive.

**Gradual rollout:**
- `ChatCommand.voiceTriggers` is optional. Existing commands without triggers keep working.
- Voice triggers can be added incrementally to each command without re-shipping the dispatch code.

**LiveSurface integration (future):**
- The LiveSurface (full-window voice mode, separate workstream) can reuse `intent.ts` and `dispatch.ts` unchanged. The only difference: LiveSurface will render voice-driven UI in its own surface instead of in the chat thread.

## Success Metrics

1. **User can trigger /model via voice** — say "switch model", see picker, pick one, model switches.
2. **All wired slash commands voice-enabled** — `/help`, `/clear`, `/new`, `/load`, `/skills`, `/btw`, `/exam` all work via voice.
3. **No false positives in normal dictation** — user dictating "I want to switch the context of my problem" should NOT trigger `/model`. (Score threshold tuned in tests.)
4. **Zero server changes** — backend remains unchanged.
5. **Test coverage** — unit tests for `intent.ts`, component tests for `ModelPickerCard`, integration tests for voice → /model path.

## Future Enhancements (Out of Scope for v1)

- **Argument extraction:** "switch to claude-opus" → pre-selects claude-opus in the picker.
- **Always-on wake word:** "August, switch model" works without clicking the mic button first.
- **Server-side intent parsing:** `/api/live/intent` endpoint for richer grammar evolution and audit logging.
- **TTS confirmation:** "Switching to claude-opus-4-7" spoken feedback.
- **LiveSurface integration:** Voice commands in the full-window voice mode.
- **Multi-intent parsing:** "switch model and clear chat" executes both commands.
- **Voice command history:** Show voice transcripts in a side panel for audit.

## Open Questions

None. Design is approved and ready for implementation planning.

---

**Next Step:** Write implementation plan via `writing-plans` skill.
