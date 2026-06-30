# August: Voice Commands, Parallel Subagents, and Provider Overhaul

**Date:** 2026-06-30
**Status:** Draft
**Features:** Extensible voice command system, parallel subagent orchestration, removal of hardcoded providers

---

## Overview

This spec bundles three connected features that together make August more flexible, more powerful, and more user-driven:

1. **Extensible Voice Command Registry** — A plugin-style registry where voice commands map to handlers and UI cards rendered inline in the chat thread. Ships with core commands (model picker, calendar view, help, clear, new chat) and exposes an extension point for future plugins.
2. **Parallel Subagent System** — The main agent can spawn subagents that execute in parallel, communicate peer-to-peer, and inherit the main agent's tools (with optional restrictions). Includes work distribution, collaborative error recovery, and configurable per-agent visualization.
3. **Provider Overhaul** — All hardcoded providers are removed. Users configure their own providers via the existing Model Providers tab. New users get an onboarding flow with a "Skip for now" option so they can explore the app first.

All three features build on existing infrastructure (voice spec, workbench, model providers tab) and are pure incremental additions.

---

## Goals

1. Voice commands trigger inline UI cards (model picker, calendar, future plugins) via an extensible registry.
2. Main agent can spawn multiple subagents that execute in parallel, communicate peer-to-peer, and recover from failures collaboratively.
3. Hardcoded providers removed; user-configured providers are the only source of truth; onboarding gracefully handles "no providers yet" state.
4. Calendar feature uses August's internal events combined with external calendar via MCP tools (no new OAuth integrations).
5. No breaking changes for the existing voice command spec — this work extends it.

---

## Non-Goals

- New always-on wake word system (voice input still uses existing push-to-talk Mic button).
- Argument extraction from voice transcripts (e.g., "switch to claude-opus" picks claude-opus directly — out of scope; voice triggers intent only in v1).
- New external calendar integrations (Google/Outlook OAuth). Reuse August's MCP toolset if available; otherwise show only internal events.
- Provider auto-discovery from the network. Users explicitly add providers via the existing Model Providers tab.
- Migration path for existing hardcoded provider configurations — per user direction, this is a test environment and no users will be affected by removal.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         August Frontend                           │
│                                                                   │
│  ┌──────────────┐   ┌──────────────────┐   ┌─────────────────┐  │
│  │ Voice Input  │──▶│ Voice Command    │──▶│ UI Card         │  │
│  │ (existing)   │   │ Registry (NEW)   │   │ Renderer        │  │
│  └──────────────┘   └──────────────────┘   └─────────────────┘  │
│                              │                                    │
│                              ▼                                    │
│  ┌──────────────┐   ┌──────────────────┐   ┌─────────────────┐  │
│  │ Provider     │◀──│ Provider Config  │   │ Subagent        │  │
│  │ Setup        │   │ (user-only)      │   │ Visualization   │  │
│  │ Onboarding   │   │ (NEW)            │   │ (NEW)           │  │
│  └──────────────┘   └──────────────────┘   └─────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                         August Backend                            │
│                                                                   │
│  ┌──────────────┐   ┌──────────────────┐   ┌─────────────────┐  │
│  │ Workbench    │──▶│ Subagent         │──▶│ Message Bus     │  │
│  │ Main Agent   │   │ Orchestrator     │   │ (NEW)           │  │
│  └──────────────┘   │ (NEW)            │   └─────────────────┘  │
│                     └──────────────────┘            │             │
│                              │                      ▼             │
│                              ▼            ┌─────────────────┐    │
│                     ┌──────────────────┐  │ Subagent Pool   │    │
│                     │ Provider Store   │  │ (workers)       │    │
│                     │ (no hardcoded)   │  │ (NEW)           │    │
│                     └──────────────────┘  └─────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Feature 1: Extensible Voice Command Registry

### Core Concept

A registry of voice commands where each entry binds:
- A set of trigger phrases (voice and optional slash command)
- A handler function (what to do when triggered)
- An optional UI card component (rendered inline in chat thread)

Built-in commands ship with the app. New commands can be registered at runtime by future plugins.

### Data Model

**File:** `frontend/desktop/src/api/voice/registry.ts`

```typescript
export interface VoiceCommandDefinition {
  id: string;
  triggers: string[];
  slashCommand?: string;
  handler: VoiceCommandHandler;
  uiCard?: React.ComponentType<VoiceCommandCardProps>;
  category: 'core' | 'plugin';
  description: string;
}

export type VoiceCommandHandler = (context: VoiceCommandContext) => void | Promise<void>;

export interface VoiceCommandContext {
  sessionId: string;
  transcript: string;
  args?: string;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export interface VoiceCommandCardProps {
  sessionId: string;
  onDismiss: () => void;
  context?: Record<string, any>;
}

class VoiceCommandRegistry {
  private commands: Map<string, VoiceCommandDefinition> = new Map();

  register(definition: VoiceCommandDefinition): void;
  unregister(id: string): void;
  matchCommand(transcript: string): VoiceCommandDefinition | null;
  getAllCommands(): VoiceCommandDefinition[];
  getCommandsByCategory(category: 'core' | 'plugin'): VoiceCommandDefinition[];
}

export const voiceCommandRegistry = new VoiceCommandRegistry();
```

### Built-in Commands

Pre-registered on app startup:

| Command ID      | Triggers                                          | Slash Cmd  | UI Card             | Handler                       |
|-----------------|---------------------------------------------------|------------|---------------------|-------------------------------|
| `model-picker`  | "switch model", "change model", "select model"    | `/model`   | `ModelPickerCard`   | Mounts picker inline          |
| `calendar-view` | "show calendar", "my calendar", "show events"     | `/calendar`| `CalendarCard`      | Mounts calendar inline        |
| `help`          | "help", "show commands", "what can you do"        | `/help`    | `CommandHelpCard`   | Shows command list (existing) |
| `clear-chat`    | "clear chat", "start over"                        | `/clear`   | none                | Clears messages               |
| `new-chat`      | "new chat", "new conversation"                    | `/new`     | none                | Starts new session            |
| `load-session`  | "load session", "open session"                    | `/load`    | none                | Opens session loader          |
| `skills`        | "show skills", "list skills"                      | `/skills`  | none                | Opens skills manager          |
| `btw`           | "by the way"                                      | `/btw`     | none                | Adds context note             |
| `exam`          | "start exam", "open exam"                         | `/exam`    | none                | Opens exam mode               |

### Matching Algorithm

Implemented as `voiceCommandRegistry.matchCommand(transcript)`:

1. Normalize transcript: lowercase, strip punctuation, collapse whitespace.
2. Tokenize.
3. For each registered command, score each of its triggers:
   - Exact substring match: score += 2
   - Token overlap ratio: score += (matched tokens / max(trigger tokens, transcript tokens))
4. Take command's max score across its triggers.
5. Discard scores below threshold (0.6).
6. Return highest-scoring command; null if no match.
7. Tie-break: prefer more exact token overlap, then first-registered.

### Built-in Card: ModelPickerCard

**File:** `frontend/desktop/src/sections/chat/ModelPickerCard.tsx`

Grouped-by-provider list of available models. Click a model → switches session model + dismisses card.

- Data sources: `useModels()` + `useProviderAvailability()`
- Empty state: "No models available. Add a provider in Settings." with [Go to Settings →] button
- Keyboard nav: arrow keys + Enter; Escape dismisses
- Visual: matches `CommandHelpCard` style (Card + CardHeader + CardContent)

### Built-in Card: CalendarCard

**File:** `frontend/desktop/src/sections/chat/CalendarCard.tsx`

Week-view layout with day cards spanning multiple weeks. Each day card lists its events.

Data sources:
- August internal events: tasks, reminders, scheduled chats from August's own event store
- External calendar events: via MCP tools if a calendar MCP server is configured (checks `useMcpTools()` for tool names like `calendar.list_events`, `gcal.events.list`)
- If no MCP calendar configured, show only internal events with a hint "Connect a calendar MCP server for external events"

Layout:
```
┌─ Calendar ──────────────────────────────── × ┐
│  Week of June 30 — July 6                    │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┐ │
│  │ Mon  │ Tue  │ Wed  │ Thu  │ Fri  │ Sat  │ │
│  │ 30   │ 1    │ 2    │ 3    │ 4    │ 5    │ │
│  │ ─    │ • 9a │ ─    │ • 2p │ ─    │ ─    │ │
│  │      │ Mtg  │      │ Demo │      │      │ │
│  └──────┴──────┴──────┴──────┴──────┴──────┘ │
│  [< Prev Week]              [Next Week >]    │
└──────────────────────────────────────────────┘
```

### Integration: ChatComposer voice routing

```typescript
// frontend/desktop/src/sections/chat/ChatComposer.tsx
const handleVoiceFinal = (transcript: string) => {
  const matchedCommand = voiceCommandRegistry.matchCommand(transcript);
  if (matchedCommand) {
    matchedCommand.handler({ sessionId, transcript, messages, setMessages });
    setInputText('');
    return;
  }
  setInputText(prev => prev + (prev ? ' ' : '') + transcript);
};
```

### Integration: Slash command dispatcher

```typescript
// frontend/desktop/src/sections/chat/ChatThread.tsx
const handleSlashCommand = (command: string) => {
  const voiceCommand = voiceCommandRegistry
    .getAllCommands()
    .find(cmd => cmd.slashCommand === command);
  if (voiceCommand) {
    voiceCommand.handler(context);
    return;
  }
  // Fall back to legacy switch/case
};
```

### Integration: UI Card rendering

```typescript
// In message renderer
if (message.kind === 'voice-command-card') {
  const command = voiceCommandRegistry
    .getAllCommands()
    .find(c => c.id === message.commandId);
  if (command?.uiCard) {
    const Card = command.uiCard;
    return <Card sessionId={sessionId} onDismiss={handleDismissCard} context={message.context} />;
  }
}
```

### Extension Point for Plugins

```typescript
voiceCommandRegistry.register({
  id: 'custom-command',
  triggers: ['show my data'],
  slashCommand: '/custom',
  handler: async (ctx) => { /* ... */ },
  uiCard: MyCustomCard,
  category: 'plugin',
  description: 'Shows custom data visualization',
});
```

### Files

**New:**
- `frontend/desktop/src/api/voice/registry.ts`
- `frontend/desktop/src/api/voice/registry.test.ts`
- `frontend/desktop/src/api/voice/builtins.ts` (registers all built-in commands)
- `frontend/desktop/src/sections/chat/ModelPickerCard.tsx`
- `frontend/desktop/src/sections/chat/ModelPickerCard.test.tsx`
- `frontend/desktop/src/sections/chat/CalendarCard.tsx`
- `frontend/desktop/src/sections/chat/CalendarCard.test.tsx`

**Modified:**
- `frontend/desktop/src/sections/chat/commands-data.ts` (deprecate; registry is the new source)
- `frontend/desktop/src/sections/chat/ChatComposer.tsx`
- `frontend/desktop/src/sections/chat/ChatThread.tsx`
- `frontend/desktop/src/main.tsx` (import builtins to trigger registration)

---

## Feature 2: Parallel Subagent System

### Core Concept

The main workbench agent can spawn one or more subagents that:
- Execute in parallel (independently or coordinated)
- Inherit the main agent's tools by default; main agent may restrict tools at spawn time
- Communicate peer-to-peer via a message bus (share intermediate results, avoid conflicts)
- Recover from failures collaboratively (peer recovery → escalate to main agent → ask user)
- Distribute work using one of several modes (auto, user-specified, negotiated, or proposed-then-approved)

### Spawning Modes

The user can request subagent spawning explicitly ("spawn 3 agents to refactor these files"). The main agent can also suggest spawning and ask for permission. Both paths are supported.

### Tool Inheritance

Subagents inherit the main agent's tool set by default. The main agent can pass a `restrictedTools: string[]` field at spawn time to allowlist a subset for a particular subagent.

```typescript
interface SubagentSpawnRequest {
  taskId: string;
  parentAgentId: string;
  goal: string;
  restrictedTools?: string[];  // optional allowlist
  workDistributionMode: 'auto' | 'user-specified' | 'negotiated' | 'proposed';
  workBreakdown?: WorkItem[];  // pre-defined work items for user-specified or proposed modes
}
```

### Work Distribution Modes

| Mode             | Who decides breakdown                      | Approval gate                   |
|------------------|--------------------------------------------|----------------------------------|
| `auto`           | Main agent plans entirely                  | None                             |
| `user-specified` | User provides breakdown                    | None                             |
| `negotiated`     | Subagents negotiate after spawn            | None                             |
| `proposed`       | Main agent proposes; user approves         | User reviews and confirms        |

### Subagent Lifecycle

```
spawn → initialize (tools + context) → execute → publish progress → 
  ↓
[success] → publish result → terminate
[failure] → broadcast to peers → 
  ↓
[peer can help] → peer takes over → execute → publish result
[no peer can help] → escalate to main agent → 
  ↓
[main agent retries] → spawn replacement subagent
[main agent gives up] → report to user, ask how to proceed
```

### Backend: SubagentOrchestrator Service

**File:** `backend/services/subagent-orchestrator.js`

Responsibilities:
- Maintain the subagent worker pool
- Spawn subagents on request
- Subscribe each subagent to the message bus
- Route messages between subagents
- Detect failures (timeout, error) and trigger recovery
- Report consolidated progress to the main agent and frontend

API:

```javascript
class SubagentOrchestrator {
  async spawn(request: SubagentSpawnRequest): Promise<SubagentHandle>;
  async terminate(taskId: string): Promise<void>;
  async listActive(): Promise<SubagentInfo[]>;
  on(event: 'progress' | 'complete' | 'failure', handler: (event) => void): void;
}
```

### Backend: Message Bus

**File:** `backend/services/agent-message-bus.js`

In-process pub/sub (for v1; can be upgraded to Redis later) for inter-agent communication:

```javascript
class AgentMessageBus {
  publish(topic: string, message: AgentMessage): void;
  subscribe(topic: string, handler: (msg: AgentMessage) => void): Subscription;
  
  // Special topics:
  // - 'task:{taskId}:progress' — progress updates
  // - 'task:{taskId}:result' — final results
  // - 'task:{taskId}:failure' — failure broadcasts
  // - 'task:{taskId}:peer-help' — peer assistance requests
}

interface AgentMessage {
  fromAgentId: string;
  toAgentId?: string;  // omit for broadcast
  type: 'progress' | 'result' | 'failure' | 'peer-help' | 'data';
  payload: any;
  timestamp: number;
}
```

### Backend: Subagent Worker

**File:** `backend/services/subagent-worker.js`

Each subagent is an isolated context running an LLM API call with its own tool set. Implemented as an async function (not a separate process for v1; can be upgraded to worker_threads or separate processes later).

```javascript
async function runSubagent(spec: SubagentSpec, bus: AgentMessageBus): Promise<SubagentResult> {
  // 1. Initialize tools (inherited from parent, filtered by restrictedTools)
  // 2. Build context (goal + work item + shared session state)
  // 3. Execute LLM tool loop:
  //    - On each step, publish progress to bus
  //    - Listen for peer messages (data sharing, peer-help)
  //    - On error, publish failure to bus
  // 4. Publish result
  // 5. Return result
}
```

### Backend: API Endpoints

**New routes** in `backend/routes/subagent-routes.js`:

| Endpoint                          | Method | Purpose                                |
|-----------------------------------|--------|----------------------------------------|
| `/api/subagents/spawn`            | POST   | Spawn one or more subagents            |
| `/api/subagents/active`           | GET    | List active subagents for a session    |
| `/api/subagents/:id/terminate`    | POST   | Terminate a running subagent           |
| `/api/subagents/stream`           | GET    | SSE stream of subagent events          |
| `/api/subagents/propose-breakdown`| POST   | Main agent asks for work breakdown approval |

### Backend: Tool Integration

Add a new managed tool `spawn_subagents` that the main agent can call:

```javascript
// backend/services/tools/spawn-subagents-tool.js
const spawnSubagentsTool = {
  name: 'spawn_subagents',
  description: 'Spawn N parallel subagents to complete work items concurrently.',
  parameters: {
    type: 'object',
    properties: {
      workItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            goal: { type: 'string' },
            restrictedTools: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      mode: { enum: ['auto', 'proposed', 'negotiated'] },
    },
    required: ['workItems'],
  },
  async execute({ workItems, mode }, ctx) {
    if (mode === 'proposed') {
      // Send approval request to frontend, wait for user confirmation
    }
    const handles = await Promise.all(
      workItems.map(item => orchestrator.spawn({ ...item, parentAgentId: ctx.agentId }))
    );
    return { spawnedAgentIds: handles.map(h => h.taskId) };
  },
};
```

### Frontend: Subagent Visualization

**File:** `frontend/desktop/src/components/chat/SubagentPanel.tsx`

Configurable view with two modes:
- **Collapsed (default):** Single line showing "3 agents working… 2/3 complete"
- **Expanded:** Card per subagent showing goal, current step, tool calls, progress

User toggle: settings option `subagentView: 'collapsed' | 'expanded'` stored in the same place as the live (STT/TTS) settings.

```typescript
interface SubagentPanelProps {
  sessionId: string;
}

export function SubagentPanel({ sessionId }: SubagentPanelProps) {
  const { agents, events } = useSubagentStream(sessionId);
  const { preference } = useSubagentViewPreference();

  if (agents.length === 0) return null;

  const summary = `${agents.filter(a => a.status === 'complete').length} / ${agents.length} agents complete`;

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between">
          <span>{summary}</span>
          <button onClick={toggleView}>
            {preference === 'collapsed' ? 'Expand' : 'Collapse'}
          </button>
        </div>
      </CardHeader>
      {preference === 'expanded' && (
        <CardContent>
          {agents.map(agent => <SubagentRow key={agent.id} agent={agent} events={events.filter(e => e.agentId === agent.id)} />)}
        </CardContent>
      )}
    </Card>
  );
}
```

### Frontend: SSE Stream

**File:** `frontend/desktop/src/api/subagents.ts`

```typescript
export function subscribeToSubagentEvents(sessionId: string, onEvent: (event: SubagentEvent) => void): () => void {
  const eventSource = new EventSource(`/api/subagents/stream?sessionId=${sessionId}`);
  eventSource.onmessage = (e) => onEvent(JSON.parse(e.data));
  return () => eventSource.close();
}
```

### Failure Recovery Flow

1. Subagent A throws or times out → publishes `failure` event to bus.
2. Peer subagents receive the failure event. If any peer determines it can help (based on its current work and capabilities), it publishes `peer-help` claiming the failed work.
3. If no peer claims the work within a short window (e.g., 5 seconds), orchestrator escalates to main agent.
4. Main agent decides: retry with new subagent, ask user, or give up.
5. If main agent asks user, send a `subagent-approval` UI card to the chat thread.

### Files

**New backend:**
- `backend/services/subagent-orchestrator.js`
- `backend/services/agent-message-bus.js`
- `backend/services/subagent-worker.js`
- `backend/services/tools/spawn-subagents-tool.js`
- `backend/routes/subagent-routes.js`
- `backend/test/subagent-orchestrator.test.js`

**New frontend:**
- `frontend/desktop/src/api/subagents.ts`
- `frontend/desktop/src/components/chat/SubagentPanel.tsx`
- `frontend/desktop/src/components/chat/SubagentRow.tsx`
- `frontend/desktop/src/sections/chat/SubagentApprovalCard.tsx`
- `frontend/desktop/src/hooks/useSubagentStream.ts`
- `frontend/desktop/src/hooks/useSubagentViewPreference.ts`

**Modified:**
- `backend/index.js` (register new routes; expose spawn_subagents tool)
- `frontend/desktop/src/sections/chat/ChatThread.tsx` (mount SubagentPanel)
- `frontend/desktop/src/sections/settings/WorkspaceModelsSection.tsx` (add view preference)

---

## Feature 3: Provider Overhaul (No Hardcoded Providers)

### Core Concept

Remove all hardcoded provider configurations. Users configure their own providers exclusively. New users see an onboarding modal with three options:
- **Set up a provider now** — opens the existing Model Providers tab
- **Skip for now** — closes the modal; user can explore the app, will be prompted again when they try to send a message
- **Import config** — paste a JSON config (for power users moving between machines)

**Key principle:** All providers are user-configured. There is no distinction between "builtin" and "custom" providers. When a user adds OpenAI, Anthropic, or a local Ollama server, they're all treated identically as user-configured providers.

### How Model Dropdown Works

**Current implementation (Python backend):**
- `GET /api/models` is handled by `backend-py/app/services/model_service.py`
- `_aggregate_models()` (line 202-239) reads from `providers.json` only
- Already fetches models from user-configured providers exclusively
- No hardcoded models are injected

**With this change:**
- **No change needed** to the model aggregation logic
- When a user adds a provider (via template or manually), their models immediately appear in `/api/models`
- The frontend model dropdown (`useModels` hook) already calls `/api/models`, so it will automatically show the latest user-configured providers
- Cache invalidation already happens when providers are added/removed (line 89, 118, 136, 198, 223, 244, 260 in `routers/providers.py`)

**Template-provided default models:**
- When a user adds a provider from a template, the template's `defaultModels` are written to `providers.json` as a starting point
- User can manually add more models via "Add Model" button
- User can auto-fetch models from the provider's `/models` endpoint via "Refresh Models" button (already implemented in `routers/providers.py:140-200`)

**Example flow:**
1. User clicks "Add Provider" → selects "Anthropic" template
2. Form pre-fills: baseUrl, apiFormat, defaultModels
3. User enters API key, clicks Save
4. Backend writes to `providers.json`:
   ```json
   {
     "id": "anthropic-abc123",
     "name": "Anthropic",
     "baseUrl": "https://api.anthropic.com/v1/messages",
     "apiFormat": "anthropic",
     "apiKey": "sk-ant-...",
     "enabled": true,
     "models": [
       {"id": "claude-opus-4-7", "contextWindow": 200000},
       {"id": "claude-sonnet-4-7", "contextWindow": 200000}
     ]
   }
   ```
5. `model_service.invalidate_cache()` is called
6. Next `/api/models` request returns the new models
7. Model dropdown in chat automatically updates

### Provider Templates (Not Hardcoded Providers)

Instead of shipping with active providers, August ships with **provider templates** — JSON metadata that makes it easy to add common providers.

**Template structure:**
```json
{
  "templates": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "baseUrl": "https://api.anthropic.com/v1/messages",
      "apiFormat": "anthropic",
      "description": "Claude models from Anthropic",
      "docsUrl": "https://console.anthropic.com/",
      "requiresApiKey": true,
      "defaultModels": [
        {"id": "claude-opus-4-7", "contextWindow": 200000},
        {"id": "claude-sonnet-4-7", "contextWindow": 200000}
      ]
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1/chat/completions",
      "apiFormat": "openai-chat",
      "description": "GPT models from OpenAI",
      "docsUrl": "https://platform.openai.com/api-keys",
      "requiresApiKey": true,
      "defaultModels": [
        {"id": "gpt-4o", "contextWindow": 128000},
        {"id": "o1", "contextWindow": 200000}
      ]
    },
    {
      "id": "ollama",
      "name": "Ollama (Local)",
      "baseUrl": "http://localhost:11434/v1/chat/completions",
      "apiFormat": "openai-chat",
      "description": "Run models locally with Ollama",
      "docsUrl": "https://ollama.ai",
      "requiresApiKey": false,
      "defaultModels": [
        {"id": "llama3", "contextWindow": 8192}
      ]
    }
  ]
}
```

**Storage location:** `backend-py/app/data/provider_templates.json`

**How templates work:**
1. User clicks "Add Provider" in Model Providers tab
2. UI shows a list of templates (or "Custom" for fully manual entry)
3. User selects a template (e.g., "Anthropic")
4. Form pre-fills with template values (baseUrl, apiFormat, defaultModels)
5. User adds their API key
6. On save, a new entry is created in `providers.json` — it's **not** marked as "custom" or "builtin", it's just a provider

### Existing UI Reuse

The existing Model Providers tab (already in the Python backend at `/api/providers`) handles the actual provider configuration. We extend it to show template selection when adding a new provider.

### Backend Changes (Python)

**Remove:**
- `backend-py/app/providers/builtin.py` — the `register_all()` function that hardcodes providers
- All individual provider files in `backend-py/app/providers/*.py` (anthropic.py, openai_api.py, etc.) — these become obsolete since providers are now defined in templates
- `backend-py/app/providers/registry.py` — the in-memory provider registry (replaced by `providers.json` as the single source of truth)

**Migration note:** The individual provider files (anthropic.py, openai_api.py, etc.) contain metadata like base URLs, API formats, and model profiles. This metadata is extracted and moved to `provider_templates.json`. The Python modules themselves are deleted since there's no code logic needed — providers are pure data now.

**Add:**
- `backend-py/app/data/provider_templates.json` — template definitions
- `backend-py/app/routers/providers.py` — new endpoint `GET /api/providers/templates` to serve templates to frontend

**Keep / Verify:**
- `providers.json` remains the source of truth for user-configured providers
- API endpoints (`/api/providers/*`) continue to work but only operate on user-configured data
- API key resolution: user-supplied keys only (no fallback to baked-in defaults)
- **Model dropdown (`/api/models`)** already fetches from `providers.json` only (verified in `backend-py/app/services/model_service.py:202-239`)

**What about `backend-py/app/providers/resolver.py` and `model_resolver.py`?**
- These files handle provider selection logic (e.g., routing requests to the right provider)
- Currently, `resolver.py` checks both `providers.json` (custom store) and the builtin registry
- **Change needed:** Remove all references to the builtin registry; only read from `providers.json`
- The `resolve()` function (line 29-123) currently:
  1. Checks custom store first
  2. Falls back to builtin registry
  3. Performs alias resolution, model profile matching, etc.
- **After change:** Steps 2-3 still work, but all provider data comes from `providers.json` only
- Remove the `register_all()` calls (lines 44, 129) since there's no builtin registry to populate
- Remove the `is_custom` field distinction (line 19) — all providers are "custom" now (user-configured)

### Onboarding Flow

**New component:** `frontend/desktop/src/components/overlays/ProviderOnboardingModal.tsx`

Triggered:
- On first launch when `providers.json` is empty or missing
- Optionally re-triggered when the user attempts to send a message but no providers are configured

Modal content:
```
┌────────────────────────────────────────────────┐
│  Welcome to August                          ×  │
│                                                │
│  August connects to AI model providers to     │
│  do its work. To get started, set up at       │
│  least one provider (OpenAI, Anthropic, etc.) │
│                                                │
│  [Set Up a Provider]   [Import Config]        │
│                                                │
│                  Skip for now →               │
└────────────────────────────────────────────────┘
```

Clicking **Set Up a Provider** opens the Settings overlay scrolled to the Model Providers tab.

Clicking **Skip for now** closes the modal. A persistent banner at the top of the chat suggests setting up a provider; can be dismissed.

### Provider-less State

When no providers are configured:
- Voice commands still work (matching logic doesn't require providers)
- The model picker card (when triggered) shows the empty state with a link to Settings
- Sending a message shows an inline error: "No provider configured. [Set Up a Provider →]"
- Subagent spawning is disabled (the `spawn_subagents` tool returns an error: "Configure a provider first")

### Frontend Changes

**New components:**
- `frontend/desktop/src/components/overlays/ProviderOnboardingModal.tsx` — first-launch modal with "Set Up", "Skip", "Import" options
- `frontend/desktop/src/components/overlays/ProviderOnboardingModal.test.tsx`
- `frontend/desktop/src/components/chat/NoProviderBanner.tsx` — persistent banner when no providers configured
- `frontend/desktop/src/hooks/useProviderOnboardingState.ts` — tracks whether user has seen onboarding
- `frontend/desktop/src/hooks/useProviderTemplates.ts` — fetches `/api/providers/templates`

**Modified components:**
- `frontend/desktop/src/App.tsx` — mount onboarding modal when no providers configured
- `frontend/desktop/src/sections/chat/ChatComposer.tsx` — show NoProviderBanner if no providers
- `frontend/desktop/src/sections/chat/ModelPickerCard.tsx` — already handles empty state per voice spec
- Model Providers settings UI — add template selection dropdown when adding a provider
- **`frontend/desktop/src/sections/workspace/LiveSettingsTab.tsx`** — replace text inputs with model dropdowns for `sttModel` and `ttsModel` fields

### Live Settings Model Dropdown

**Current behavior (v4.2):**
- `sttModel` and `ttsModel` are free-text input fields
- User must manually type model IDs (error-prone, no autocomplete)

**New behavior:**
- Replace text inputs with dropdowns that fetch from `/api/models` (same as chat model picker)
- Filter models by provider if `sttProvider`/`ttsProvider` is set
- Show all models if provider field is empty
- Empty option = "Use provider default"

**Implementation:**
```tsx
// In LiveSettingsTab.tsx
const { models } = useModels(); // Reuse existing hook

// For sttModel field:
<select
  value={active.sttModel}
  onChange={(e) => setEditCfg({ ...active, sttModel: e.target.value })}
>
  <option value="">(use provider default)</option>
  {models
    .filter(m => !active.sttProvider || m.provider === active.sttProvider)
    .map(m => (
      <option key={m.id} value={m.id}>
        {m.name || m.id}
      </option>
    ))}
</select>
```

**Why this matters:**
- Consistency: same model picker UX as chat
- Discoverability: users see available models from their configured providers
- Correctness: prevents typos in model IDs
- Dynamic: when user adds a provider, new models immediately appear in Live settings

### Files Summary

**New:**
- `backend-py/app/data/provider_templates.json`
- `frontend/desktop/src/components/overlays/ProviderOnboardingModal.tsx`
- `frontend/desktop/src/components/overlays/ProviderOnboardingModal.test.tsx`
- `frontend/desktop/src/components/chat/NoProviderBanner.tsx`
- `frontend/desktop/src/hooks/useProviderOnboardingState.ts`
- `frontend/desktop/src/hooks/useProviderTemplates.ts`

**Modified:**
- `backend-py/app/routers/providers.py` — add `GET /api/providers/templates` endpoint
- `backend-py/app/providers/builtin.py` — remove or stub out (no longer registers hardcoded providers)
- `backend-py/app/providers/resolver.py` — remove builtin registry fallback, only read from `providers.json`
- `backend-py/app/routers/terminal_routes.py` — verify PTY spawning works correctly on all platforms
- `frontend/desktop/src/App.tsx` — mount onboarding modal
- `frontend/desktop/src/sections/chat/ChatComposer.tsx` — show banner if no providers
- `frontend/desktop/src/sections/workspace/LiveSettingsTab.tsx` — replace text inputs with model dropdowns
- `frontend/desktop/src/sections/chat/ChatSidebar.tsx` (or ChatLayout) — add "Open Folder" button using Tauri dialog
- `frontend/desktop/src/store/sessions.ts` — add auto-folder creation when session has workspacePath
- `src-tauri/tauri.conf.json` — verify permissions (fs, dialog), backend bundling
- Model Providers settings UI — add template picker

**Audit:**
- All settings sections (`frontend/desktop/src/sections/workspace/*`, `frontend/desktop/src/sections/settings/*`) — ensure React Query with staleTime
- All WebSocket connections — ensure correct port in desktop mode
- Backend spawning logic in `src-tauri/src/main.rs` — verify Python backend launches correctly

**Removed:**
- `backend-py/app/providers/anthropic.py` (and all other individual provider files — moved to templates)
- `backend-py/app/providers/registry.py` (no longer needed; `providers.json` is the registry)

---

## Desktop App Requirements (Tauri)

### Core Principle
August is a **Tauri v2 desktop application**, not a web-only app. All features must work correctly when built and distributed as a native desktop app on Windows, macOS, and Linux.

### Terminal Integration

**Current behavior:**
- Right drawer shows xterm.js terminal with WebSocket connection to backend PTY
- "Starting real terminal..." message appears briefly during connection
- Uses xterm.js for rendering, backend spawns actual shell (bash/zsh/PowerShell)

**Requirements:**
1. **System default shell** — Backend should spawn the user's default shell:
   - Windows: PowerShell Core (pwsh) or Windows PowerShell (powershell.exe) or Git Bash
   - macOS/Linux: user's `$SHELL` (bash, zsh, fish, etc.)
2. **No persistent "starting terminal" message** — Connection should be fast (<500ms)
   - If backend PTY fails to spawn, show error: "Failed to start terminal. Check logs."
   - Once connected, the xterm.js terminal should immediately show the shell prompt
3. **Verify backend PTY implementation:**
   - `backend-py/app/routers/terminal_routes.py` and `terminal_service` must correctly spawn PTY sessions
   - Use `pty.spawn()` (Unix) or `winpty`/`conpty` (Windows) for real shell sessions
   - WebSocket should stream I/O bidirectionally without delays

**If terminal is currently broken:**
- Add this to Phase 2 implementation: audit and fix terminal PTY spawning
- Ensure xterm.js WebSocket connects to `/api/terminal/connect` successfully
- Test on Windows (PowerShell), macOS (zsh), and Linux (bash)

### Folder/Project Selection → Session Creation

**Expected behavior:**
When a user opens a folder via File Explorer (or drag-drops a folder onto August):
1. A new session is created with `workspacePath` set to the folder path
2. The session appears in the sidebar, grouped under a folder if applicable
3. The workspace file tree (right panel) automatically loads that folder's contents

**Current implementation:**
- `createSession(folderId, title, workspacePath)` already supports `workspacePath` (line 78-94 in `sessions.ts`)
- Sessions have a `workspacePath` field (line 13 in `sessions.ts`)
- Folders can have a `workspacePath` field (line 40-42 in `sessions.ts`)

**Requirements:**
1. **Tauri file dialog integration:**
   ```tsx
   // Example: Add "Open Folder" button in sidebar
   import { open } from '@tauri-apps/plugin-dialog';
   
   const handleOpenFolder = async () => {
     const selected = await open({
       directory: true,
       multiple: false,
     });
     if (selected) {
       const newSession = createSession(null, selected.name || 'New Project', selected.path);
       navigate(`/chat/${newSession.id}`);
     }
   };
   ```
2. **Auto-create folder in sidebar:**
   - If a session has a `workspacePath` that doesn't match any existing folder, auto-create a folder for it
   - Folder name = last path segment (e.g., `/home/user/my-project` → "my-project")
3. **Workspace panel auto-loads:**
   - When session has `workspacePath`, the workspace file tree (WorkspacePanel.tsx) should auto-load that directory
   - Already implemented: line 28-35 in WorkspacePanel.tsx syncs with `activeSession.workspacePath`

**Implementation:**
- Add "Open Folder" button to sidebar (ChatSidebar or ChatLayout)
- Use `@tauri-apps/plugin-dialog` for native folder picker
- Call `createSession(null, folderName, folderPath)` on selection
- Verify workspace panel auto-loads the folder

### Build & Distribution

**Tauri-specific concerns:**
1. **Backend bundling** — Python backend (`backend-py`) must be bundled with the Tauri app
   - Check `src-tauri/tauri.conf.json` for `beforeBuildCommand` and `beforeDevCommand`
   - Backend binary should be included in `resources` and spawned by Tauri on app start
2. **WebSocket URLs** — Use `ws://localhost:<PORT>` not `window.location.host` in production
   - Port should be determined at runtime (backend chooses free port, communicates to frontend)
3. **File system access** — Tauri restricts file access; ensure `allowlist` permissions are set
   - `fs.readDir`, `fs.readFile`, `fs.writeFile` needed for workspace panel
   - `dialog.open` needed for folder picker
4. **Provider templates** — `backend-py/app/data/provider_templates.json` must be bundled in resources
5. **Config persistence** — `providers.json`, `config.json` should be in user data directory
   - Use Tauri's `appDataDir` or `appConfigDir` paths

**Files to audit:**
- `src-tauri/tauri.conf.json` — verify permissions, build commands, resources
- `src-tauri/src/main.rs` — verify backend spawning, port negotiation
- `frontend/desktop/src/lib/tauri-detect.ts` — verify runtime detection works
- All WebSocket connections — ensure they use correct port in desktop mode

### Cross-Feature Concerns

### Settings Navigation & Real-Time Data Flow

**Current issue:**
- Settings tabs appear to "reload" when switching between them
- Data may not update in real-time without manual refresh

**Requirements:**
1. **No reload on tab switch** — React Router navigation should be instant; components should not unmount/remount unnecessarily
2. **Real-time data flow** — all settings data should update automatically via:
   - React Query cache invalidation
   - SSE/WebSocket subscriptions for live data
   - Optimistic updates on mutations

**Implementation:**
- **Settings tabs persist data** — use React Query with staleTime to prevent refetch on tab switch
  ```tsx
  // Example: WorkspaceModelsSection.tsx
  const { data: providers } = useQuery({
    queryKey: ['providers'],
    queryFn: () => providersApi.list(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
  ```
- **Live settings model dropdown** — already uses `useModels()` hook which caches `/api/models`
- **Provider changes propagate immediately** — when a provider is added/edited/deleted:
  1. Backend calls `model_service.invalidate_cache()`
  2. Frontend mutation invalidates `['providers']` and `['models']` query keys
  3. All components using those queries automatically re-render with fresh data
- **No full-page reloads** — WorkspaceShell already uses React Router; verify all navigation is client-side
- **Shared query cache** — React Query client is singleton at app root; all settings sections share the same cache

**Files to audit:**
- All `frontend/desktop/src/sections/workspace/*` components — ensure they use React Query with appropriate `staleTime`
- All `frontend/desktop/src/sections/settings/*` components — same as above
- Verify no `window.location.href` or `<a href>` tags are used for internal navigation (should use `navigate()` or `<Link>`)

### State Management

- **Voice command registry** is a singleton instantiated at app boot in `main.tsx`.
- **Subagent state** is owned by the backend orchestrator; the frontend subscribes via SSE.
- **Provider state** is loaded from `providers.json` on backend startup and exposed via existing `/api/providers/*` routes.

### Error Handling

| Scenario                          | Behavior                                                          |
|-----------------------------------|-------------------------------------------------------------------|
| Voice command matches but handler errors | Toast error, leave transcript in composer as fallback        |
| Subagent fails                    | Peer recovery → main-agent retry → user-approval flow            |
| No providers configured           | Onboarding modal; persistent banner; inline error on send         |
| MCP calendar tool unavailable     | CalendarCard shows internal events only with a hint               |
| ProviderSTT unavailable           | Voice commands work only via Web Speech (existing limitation)     |

### Testing Strategy

**Unit:**
- `registry.test.ts` — register, unregister, matchCommand with various transcripts
- `subagent-orchestrator.test.js` — spawn, terminate, message routing, failure recovery
- `agent-message-bus.test.js` — pub/sub, peer messaging
- `useProviderOnboardingState.test.ts` — first-launch detection, skip persistence

**Component:**
- `ModelPickerCard.test.tsx` — render, click, empty state
- `CalendarCard.test.tsx` — week navigation, event rendering, no-MCP hint
- `SubagentPanel.test.tsx` — collapsed/expanded modes, multi-agent rendering
- `ProviderOnboardingModal.test.tsx` — three CTAs, skip persistence

**Integration:**
- Voice transcript "switch model" → ModelPickerCard mounted → click model → session updates
- Main agent spawns 3 subagents → SubagentPanel updates → all complete → result merged
- Subagent A fails → peer B recovers → main agent receives final result
- Fresh app launch, no providers → onboarding shows → skip → banner appears
- **Settings navigation** — switch between tabs, verify no reload, data persists
- **Real-time updates** — add provider in Settings → immediately appears in chat model dropdown and Live settings dropdown without refresh
- **Desktop app** — build Tauri app, verify backend launches, terminal works, folder picker creates sessions

**E2E (Desktop App):**
- Launch Tauri app on Windows/macOS/Linux
- Terminal: open right drawer, verify PowerShell/zsh/bash launches, run `ls`, see output
- Folder picker: click "Open Folder", select project, verify new session created with workspace loaded
- Verify WebSocket connections work (chat SSE, terminal PTY)
- Verify provider config persists across app restarts

### Performance Considerations

- Subagent worker pool capped at 5 concurrent agents (configurable later)
- Message bus uses in-process pub/sub (no Redis dependency for v1)
- Voice command matching runs on each STT final; threshold tuned to avoid false positives
- Calendar events fetched once per card mount, cached for the session

### Security & Permissions

- Subagents inherit parent's tool permissions; restrictedTools can narrow further but never expand
- Subagent failures cannot escalate privileges (peer recovery uses same tool set as failed agent)
- Provider API keys never logged or exposed via the message bus
- Voice command handlers run in the user's frontend context (same trust level as user actions)

---

## Implementation Phases

### Phase 1: Voice Command Registry (Foundation)
- Build registry, port existing commands, ship ModelPickerCard + CalendarCard
- Verify voice + slash dispatch path is unified

### Phase 2: Provider Overhaul (Decoupling)
- Remove hardcoded providers, create provider templates
- Build onboarding modal + banner
- Verify provider-less state behaviors
- **Live settings model dropdown** — replace text inputs
- **Settings navigation audit** — ensure no reload, real-time data flow

### Phase 3: Subagent Orchestrator (New Capability)
- Backend: message bus, orchestrator, worker, tool
- Frontend: SubagentPanel, SSE subscription, approval card
- Integration tests with multi-agent scenarios

### Phase 4: Desktop App Hardening (Platform)
- Audit terminal PTY spawning on Windows/macOS/Linux
- Implement "Open Folder" button with Tauri dialog
- Verify auto-folder creation for workspace sessions
- Test Tauri build & distribution (backend bundling, permissions, config persistence)
- E2E testing on all platforms

Each phase can ship independently. Phase 1 unblocks Phase 3 (voice triggers for subagent commands). Phase 2 unblocks both (clean provider state). Phase 4 ensures desktop app quality.

---

## Success Metrics

1. User says "switch model" → ModelPickerCard appears in chat → user clicks model → session model updates.
2. User says "show calendar" → CalendarCard appears with internal events; if MCP calendar is configured, external events also show.
3. Main agent spawns 3 subagents → all execute in parallel → results merge → user sees consolidated outcome.
4. Subagent A fails → peer B recovers → user sees only success (no failure noise).
5. Fresh app launch, no providers → onboarding modal appears → user can skip → app remains usable for exploration.
6. New voice command can be registered by a plugin with one `voiceCommandRegistry.register({...})` call.

---

## Future Enhancements (Out of Scope)

- Voice command argument extraction ("switch to claude-opus" pre-selects model)
- Always-on wake word
- External calendar OAuth integration (replace MCP path)
- Subagent worker_threads / separate process execution (move beyond async functions)
- Distributed message bus (Redis) for multi-machine subagent execution
- Subagent observability dashboard (history, replay, debugging)
- Plugin marketplace for community-registered voice commands
- Provider auto-detection via mDNS or local discovery

---

## Open Questions

None. All clarifying questions resolved with the user. Ready for implementation planning.

---

**Next Step:** Write implementation plan via the `writing-plans` skill.
