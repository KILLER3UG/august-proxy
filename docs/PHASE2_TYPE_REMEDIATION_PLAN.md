# Phase 2 — Pydantic Model Remediation Plan

> **Status:** Planned (Phase 1 committed as `4a3e90a`)
> **Target:** mypy 0, eslint 0, with a sustainable architecture for a multi-provider proxy gateway.
> **Design principle (proxy-specific):** *Strict on what you touch, `extra="allow"` on what you forward.*

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [What stays from Phase 1](#2-what-stays-from-phase-1)
3. [Model module layout](#3-model-module-layout)
4. [What to model strictly vs. loosely](#4-what-to-model-strictly-vs-loosely)
5. [File-by-file migration order](#5-file-by-file-migration-order)
6. [Detailed implementation steps](#6-detailed-implementation-steps)
7. [Integration with remaining STATIC_ANALYSIS_ERRORS cleanup](#7-integration-with-remaining-static_analysis_errors-cleanup)
8. [Risk assessment & mitigations](#8-risk-assessment--mitigations)

---

## 1. Architecture overview

August Proxy is a **pass-through gateway** between clients (Anthropic-format, OpenAI-format) and upstream providers (Anthropic, OpenAI, and anything OpenAI-compatible). Most of the payload is *forwarded untouched* — only a subset of fields are intercepted:

| What the proxy reads/acts on | What the proxy just forwards |
|------------------------------|------------------------------|
| `model` — routing, alias resolution | Message `content` (text, images, audio) |
| `max_tokens` / `max_output_tokens` | Role strings |
| `stream` — streaming vs. batch | Metadata / custom fields |
| `tools` / `tool_choice` — managed tool injection | Provider-specific extensions |
| `stop_sequences` — injected rules | Usage data (partially — reads input/output tokens) |
| `temperature`, `top_p`, `top_k` — pass through but read | Anthropic `thinking` / `reasoning` budget |

The type architecture implements a **layered model approach:**

```
┌──────────────────────────────────────────────────────────┐
│  Layer 1 — Boundary (dict[str, JsonValue] / extra=allow) │
│  Raw provider payloads. Fields we don't touch.           │
├──────────────────────────────────────────────────────────┤
│  Layer 2 — Routing & tool models (strict Pydantic)       │
│  Fields the proxy reads, writes, or validates.           │
│  These are the ~15% that matter for type safety.         │
├──────────────────────────────────────────────────────────┤
│  Layer 3 — Internal state & accumulators (JsonValue)     │
│  Stream state, caches, intermediate transforms.          │
│  Not worth modeling — never cross an API boundary.       │
└──────────────────────────────────────────────────────────┘
```

## 2. What stays from Phase 1

| Artifact | Kept? | Reason |
|----------|-------|--------|
| `app/jsonUtils.py` (`as_str`, `as_dict`, `as_list`, `as_int`, `as_float`) | ✅ Yes | Still useful for quick inline coercion even with models. For one-off access to `extra="allow"` fields, they're cleaner than `isinstance` chains. |
| `backend-py/mypy.ini` import overrides | ✅ Yes | Silences third-party dep noise. |  
| `cast()` calls at module boundaries | ⚠️ Mostly removed | Replaced by Pydantic model constructors which validate the boundary. A few may remain as the last resort for genuinely dynamic shapes. |
| Narrowing in `anthropic.py` / `providers.py` helpers | ⚠️ Simplified | Once function inputs become typed models, the inline `as_*` calls inside those functions become unnecessary — the model accessor gives typed fields directly. |

## 3. Model module layout

Create a new `app/models/` package:

```
backend-py/app/models/
├── __init__.py                  # Re-export all models for easy imports
├── base.py                      # Shared base models & type aliases
│                                #   ProviderResponse (already exists as TypedDict)
│                                #   JsonValue re-export
│                                #   ExtraAllowBaseModel (shared config)
│
├── anthropic.py                 # Anthropic Messages API shapes
│                                #   AnthropicRequest (extra=allow)
│                                #   AnthropicMessage
│                                #   ContentBlock (text, tool_use, thinking)
│                                #   ToolUseBlock (strict — proxy acts on tools)
│                                #   ToolResultBlock (strict — proxy constructs these)
│                                #   Usage
│                                #   AnthropicSSEEvent (message_start, etc.)
│
├── openai.py                    # OpenAI Chat Completions shapes
│                                #   ChatCompletionRequest (extra=allow)
│                                #   ChatMessage
│                                #   FunctionCall (strict — proxy acts on tools)
│                                #   ToolCall (strict — proxy acts on tools)
│                                #   Delta
│                                #   Usage
│                                #   StreamChunk
│
├── proxy.py                     # Proxy-internal shapes
│                                #   ManagedToolDefinition
│                                #   ManagedToolResult
│                                #   ToolClassificationResult
│                                #   StreamState  (if worth typing)
│
├── config.py                    # Provider configuration shapes
│                                #   ProviderConfig (covers existing ProviderCreate/Update)
│                                #   ModelConfig
│
└── common.py                    # Shared helpers that span models
                                 #   enrichRequest
                                 #   extractToolCalls
                                 #   etc.
```

### The `ExtraAllowBaseModel`

```python
# app/models/base.py
from pydantic import BaseModel, ConfigDict

class ExtraAllowBaseModel(BaseModel):
    """Base for provider payload models.

    Extra fields are accepted (not rejected) so that an upstream provider
    adding a new field doesn't break August. Fields we *act on* are typed
    explicitly; everything else passes through as raw JSON.
    """
    model_config = ConfigDict(extra="allow", populate_by_name=True)

class BaseRequest(ExtraAllowBaseModel):
    """Every provider request has at least model and stream."""
    model: str
    stream: bool = False
```

## 4. What to model strictly vs. loosely

### Strict models (fields the proxy reads/constructs)

| Model | Fields | Used by |
|-------|--------|---------|
| `ToolUseBlock` | `type: str`, `id: str`, `name: str`, `input: dict` | Tool resolution loop, classification |
| `ToolResultBlock` | `type: str`, `tool_use_id: str`, `content: str\|list`, `is_error: bool` | Tool execution, multi-round loop |
| `FunctionDefinition` | `name: str`, `description: str`, `parameters: dict` | Tool schema injection |
| `ToolDefinition` | `type: str`, `function: FunctionDefinition` | Managed tool definitions |
| `RouteRequest` | `model: str`, `provider: str`, `api_format: str` | Model alias resolution |
| `ToolClassificationResult` | `has_managed: bool`, `has_client_or_unknown: bool`, ... | Tool resolution loop |
| `ProviderConfig` | `id: str`, `name: str`, `apiFormat: str`, `apiKey: str`, `baseUrl: str`, `enabled: bool` | Provider CRUD |

### Loose models (extra="allow", typed only for fields the proxy reads)

| Model | Typed fields | Untyped fields (pass through) |
|-------|-------------|-------------------------------|
| `AnthropicRequest` | `model`, `max_tokens`, `stream`, `stop_sequences`, `tools`, `tool_choice` | `messages`, `system`, `metadata`, `thinking` |
| `OpenAIRequest` | `model`, `max_tokens`, `stream`, `stop`, `tools`, `tool_choice` | `messages`, `functions`, `logprobs`, `user` |
| `AnthropicMessage` | `role` | `content` (can be str or list) |
| `OpenAIMessage` | `role` | `content`, `tool_calls`, `function_call` |
| `StreamChunk` | `choices`, `usage` (optional) | Everything else |

### Not modeled at all (stay as `dict[str, JsonValue]`)

- **Stream state accumulators** (`createAnthropicNativeStreamState`, `createOpenaiToAnthropicStreamState`) — internal, never cross API boundary.
- **Provider response bodies** that are just forwarded — `resp.body` stays `JsonValue`.
- **Intermediate transform dicts** inside `translateMessages`, `streamOpenaiDeltaAsAnthropic` — too shape-shifting to model usefully.

## 5. File-by-file migration order

The order is chosen to **build confidence first** (model the simplest, most-contained shapes) before tackling the complex adapter files.

### Sprint 1: Foundation + tool models (low risk, high value)

| Step | File | What to do | Expected mypy Δ |
|------|------|-----------|-----------------|
| 1 | Create `app/models/` package | `__init__.py`, `base.py`, `ExtraAllowBaseModel` | — |
| 2 | Create `app/models/anthropic.py` | `ToolUseBlock`, `ToolResultBlock`, `AnthropicRequest`, `AnthropicMessage`, `ContentBlock` | — |
| 3 | Create `app/models/openai.py` | `ToolCall`, `FunctionCall`, `ChatCompletionRequest`, `ChatMessage` | — |
| 4 | `app/adapters/toolClassification.py` | Replace `getToolNameFrom*` with typed model accessors. Remove `_as_str`/`_as_dict` helpers. | −8 |
| 5 | `app/adapters/proxyTools.py` | Use `ToolDefinition` / `FunctionDefinition` models. Validate at boundary. | −4 |
| 6 | Sprint 1 checkpoint — run mypy, commit | | **Cumulative: −12** |

### Sprint 2: Router provider config (mostly mechanical)

| Step | File | What to do | Expected mypy Δ |
|------|------|-----------|-----------------|
| 7 | `app/models/config.py` | `ProviderConfig`, `ModelConfig`, `AliasConfig` models | — |
| 8 | `app/services/configService.py` | Change `getProvidersStore() -> dict[str, JsonValue]` → `list[ProviderConfig]` | −~10 |
| 9 | `app/routers/providers.py` | Use `ProviderConfig` model instead of dict. Replace `as_list`/`as_dict` with model accessors. | −88 |
| 10 | Sprint 2 checkpoint — run mypy, commit | | **Cumulative: −110** |

### Sprint 3: Anthropic adapter models (highest risk, highest reward)

| Step | File | What to do | Expected mypy Δ |
|------|------|-----------|-----------------|
| 11 | `app/adapters/anthropic.py` — function signatures | Change `body: dict[str, JsonValue]` → `body: AnthropicRequest`, `system: list[ContentBlock]`; return typed `AnthropicResponse` | −~40 |
| 12 | `app/adapters/anthropic.py` — `translateMessages` | Use `OpenAIMessage` / `AnthropicMessage` models. Remove `as_*` calls from message access. | −~30 |
| 13 | `app/adapters/anthropic.py` — `buildOpenaiRequest` | Return `ChatCompletionRequest` instead of `dict[str, JsonValue]` | −~20 |
| 14 | `app/adapters/anthropic.py` — tool resolution loop | Use `ToolUseBlock` / `ToolResultBlock` models. Remove classify casts. | −~30 |
| 15 | `app/adapters/anthropic.py` — stream functions | Use `AnthropicSSEEvent` / `StreamChunk` models for state management | −~30 |
| 16 | `app/adapters/anthropic.py` — `_getClient` | Keep `BaseProviderClient` annotation (already done in Phase 1) | 0 |
| 17 | Sprint 3 checkpoint — run mypy, commit | | **Cumulative: −~260** |

### Sprint 4: OpenAI adapter + workbench

| Step | File | What to do | Expected mypy Δ |
|------|------|-----------|-----------------|
| 18 | `app/adapters/openai.py` | Mirror Sprint 3 for OpenAI adapter: function signatures → models, remove helpers | −92 |
| 19 | `app/services/workbench/workbench.py` | Type the request-building functions, use `ChatCompletionRequest` / `AnthropicRequest` models | −123 |
| 20 | Sprint 4 checkpoint — run mypy, commit | | **Cumulative: −~475** |

### Sprint 5: Sweep remaining mypy files

| Step | File | What to do | Expected mypy Δ |
|------|------|-----------|-----------------|
| 21 | `app/services/tools/agentRegistry.py` (50) | Model the agent job types | −50 |
| 22 | `app/services/workbench/subagent.py` (29) | Model subagent request/response shapes | −29 |
| 23 | `app/services/daemonManager.py` (24) | Type daemon state dict | −24 |
| 24 | `app/services/logger.py` (20) | Keep as loose — not worth modeling | 0 (sweep with as_* helpers) |
| 25 | Remaining ~70 files with <20 errors each | Sweep with established pattern: `as_*` helpers for simple cases, models where shapes are stable | −~300 |
| 26 | Final checkpoint — run mypy, should be **0** | Commit | **Cumulative: −~878** |

### Sprint 6: ESLint (frontend)

| Step | File | What to do | Expected Δ |
|------|------|-----------|-----------|
| 27 | `src/api/*` (client.ts, workbench.ts, subagents.ts, provider-health.ts) | Define response interfaces for every fetch boundary. The `any`-family errors (~613) originate here. | −~613 |
| 28 | `npx eslint . --fix` | Auto-fix mechanical findings: `no-unused-vars`, `prefer-const`, `no-empty`, `no-useless-escape` | −~250 |
| 29 | `ChatThread.tsx` | Fix promise handling (`no-floating-promises`), `rules-of-hooks` real bug at line 2752 | −~103 |
| 30 | Sweep remaining eslint files | Address `no-base-to-string`, `camelcase`, `react-refresh`, `exhaustive-deps` | −~285 |
| 31 | Final eslint run — should be **0 errors, ≤200 warnings** | Commit | **Done** |

## 6. Detailed implementation steps

### Step 1 — Create model package

```
backend-py/app/models/__init__.py
```
```python
from .base import ExtraAllowBaseModel, JsonValue
from .anthropic import AnthropicRequest, AnthropicMessage, ContentBlock, ToolUseBlock, ToolResultBlock
from .openai import OpenAIChatCompletionRequest, ChatMessage, ToolCall
from .config import ProviderConfig
```

### Step 2 — `app/models/base.py`

The central shared base:

```python
from __future__ import annotations
from typing import TypeAlias
from pydantic import BaseModel, ConfigDict

JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]

class ExtraAllowBaseModel(BaseModel):
    """Accepts extra fields so upstream provider changes don't break us.
    Only the fields we explicitly type are validated; everything else
    passes through as raw JSON."""
    model_config = ConfigDict(extra="allow", populate_by_name=True)

class BaseRequest(ExtraAllowBaseModel):
    """Minimal shared request — every provider has at least a model and stream flag."""
    model: str
    stream: bool = False
```

### Step 3 — `app/models/anthropic.py`

Pattern for each model — strict on tool shapes, loose on forwarded content:

```python
class ToolUseBlock(ExtraAllowBaseModel):
    """Strict — the proxy constructs these and reads them in the tool loop."""
    type: str = "tool_use"
    id: str
    name: str
    input: dict[str, JsonValue]

class ToolResultBlock(ExtraAllowBaseModel):
    """Strict — the proxy constructs these in the tool resolution loop."""
    type: str = "tool_result"
    tool_use_id: str
    content: str | list[JsonValue]
    is_error: bool = False

class ContentBlock(ExtraAllowBaseModel):
    """Loose — content blocks come in many shapes (text, image, tool_use, thinking).
    Only type is typed; the rest passes through."""
    type: str

class AnthropicMessage(ExtraAllowBaseModel):
    """Loose — the proxy reads role but forwards content untouched."""
    role: str

class AnthropicRequest(BaseRequest):
    """Loose on messages, strict on routing fields."""
    max_tokens: int | None = None
    stop_sequences: list[str] | None = None
    tools: list[ToolDefinition] | None = None  # ToolDefinition is in proxy.py
    tool_choice: dict[str, JsonValue] | None = None
    # messages, system, metadata, thinking → pass through via extra="allow"
```

### Step 4 — Adapter migration strategy (the actual work)

Each adapter function follows this pattern:

**Before** (Phase 1):
```python
def buildOpenaiRequest(body: dict[str, JsonValue], model: str, system=None) -> dict[str, JsonValue]:
    openaiBody = {'model': model, 'messages': translateMessages(body.get('messages', []), system)}
    if 'max_tokens' in body:
        openaiBody['max_tokens'] = body.get('max_tokens')
    ...
    return openaiBody
```

**After** (Phase 2):
```python
def buildOpenaiRequest(body: AnthropicRequest, model: str, system=None) -> OpenAIChatCompletionRequest:
    messages = translateMessages(body.messages, system)  # .messages is now typed (loose dict)
    return OpenAIChatCompletionRequest(
        model=model,
        messages=messages,
        max_tokens=body.max_tokens,
        stream=body.stream,
        stop=body.stop_sequences,
        temperature=body.temperature,  # extra="allow" on AnthropicRequest means this could be None
    )
```

**Key principle:** Function signatures become typed at the boundary. Inside the function, you still access `body.messages` (which is a loose model — its fields are incompletely typed but `.model_dump()` gives the full dict). Only when you *read specific fields* do you get proper types.

## 7. Integration with remaining STATIC_ANALYSIS_ERRORS cleanup

The `docs/STATIC_ANALYSIS_ERRORS.md` doc now reflects this two-phase plan. Phase 2 subsumes the remaining mypy cleanup:

| Phase 2 step | STATIC_ANALYSIS_ERRORS section completed |
|-------------|----------------------------------------|
| Sprint 2 (config models) | §2.3.D `typeddict-item` / `typeddict-unknown-key` |
| Sprint 3 (anthropic adapter) | §2.3.B `union-attr` / `attr-defined` / `operator` / `arg-type` core chunk |
| Sprint 4 (openai + workbench) | Remaining §2.3.B hot files |
| Sprint 5 (sweep) | §2.3.C `call-arg` / `call-overload`; §2.3.E `used-before-def` / `override` |
| Phase 1 already covered | §2.3.A `import-not-found` / `import-untyped` (mypy.ini); §2.3.F `annotation-unchecked` (partially) |

The eslint sprints cover §3 in full.

## 8. Risk assessment & mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Model shape wrong — provider adds/removes field | Medium | Low (extra="allow" passes through silently) | Add integration test that sends a known payload through the full adapter chain |
| Model too strict — rejects a valid upstream response | Low | Medium | Use `extra="allow"` everywhere by default; only strict model for fields you explicitly read |
| Performance regression from Pydantic validation | Low | Low | Pydantic v2 is ~5-10x faster than v1; validation only happens at the boundary, not for every internal operation |
| Large diff / merge conflicts with parallel work | Medium | Low | Keep sprints small (1-2 files per commit); sprint checkpoints are natural PR boundaries |
| Partial migration — some files updated, others not, mismatch at call sites | Medium | Medium | Do sprint commits; run mypy after each sprint. If a sprint is partially done, the mypy count stays elevated but doesn't regress. |
| `extra="allow"` hides typos in field names | Low | Medium | Write tests that exercise the specific typed fields (e.g., "reading model ID from AnthropicRequest returns the correct string") |
| The `cast()` calls in Phase 1 obscure real type bugs | Low | Low | Phase 2 removes `cast()`es as fast as models are introduced. Only a handful remain at boundaries that are genuinely dynamic. |

## Appendix: Quick reference — Pydantic config for this project

```python
# When to use which config:

# 1. For payloads the proxy receives from outside (requests, responses):
class IncomingShape(ExtraAllowBaseModel):
    model_config = ConfigDict(extra="allow")
    # ...

# 2. For payloads the proxy constructs internally and controls:
class InternalShape(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)  # or frozen=False
    # ...

# 3. For payloads that cross both directions (e.g., tool definitions
#    received from client, validated, then forwarded):
class ToolDefinition(BaseModel):
    model_config = ConfigDict(extra="allow")
    # ...strict on function name/schema, lenient on extras
```

## Appendix: Sprint checklist template

For each sprint, use this checklist:

```
Sprint N: <name>
- [ ] Step X: Create/update models
- [ ] Step Y: Update adapters/providers/services
- [ ] Step Z: Remove obsolete casts/helpers
- [ ] Run mypy: before=___, after=___ 
- [ ] Import smoke: pass
- [ ] Commit (message: "phase2: sprint N — <summary>")
- [ ] Push
```
