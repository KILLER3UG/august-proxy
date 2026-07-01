# Type-Safety Hardening — Design Spec

**Date:** 2026-06-30
**Status:** Phase 0–5 implemented; Phase 6 (tests + docs) in progress.
**Branch:** `python-backend`

## Goal

Eliminate unguarded `any` usage in the frontend TypeScript, narrow
backend Python services to TypedDicts where useful, and add runtime
validation at the API boundary so backend/frontend drift surfaces as a
loud warning instead of a silent `undefined.field` crash.

## Non-Goals

- OpenAPI/GraphQL schema generation (would require FastAPI plugins and
  a codegen pipeline).
- Pydantic model migration in the backend (TypedDicts match the
  JSON-in/JSON-out style; migrating to Pydantic is a separate effort).
- Removing every existing pre-existing tsc/mypy error on the
  `python-backend` branch — those are owned by ongoing active refactors.

## Phases

### Phase 0 — Tooling bootstrap

Install and configure the type-safety stack:

- **Backend:** `mypy>=1.13.0` (matches the active `python-backend` branch
  workflow), `mypy.ini` with `python_version = 3.12`, excludes
  `app/scripts/` and `app/types.py` (which shadows stdlib `types`).
- **Frontend:** ESLint 9 + `@typescript-eslint` v8 + `react-hooks` +
  `react-refresh` + `globals`. Flat config in `eslint.config.js`.
  `no-explicit-any: warn` (escalated to `error` in Phase 2 of the
  follow-up).
- **Runtime validation:** `zod@^3.23.8`.
- **CI:** `.github/workflows/type-check.yml` runs `mypy` + `pytest` on
  backend and `tsc -b` + `eslint` on frontend for push/PR.

### Phase 1 — Mechanical fixes

The lowest-risk, highest-leverage changes:

- **`catch (e: any)` → `catch (e)` with narrowing.** 25 sites across 9
  files (ChatLayout, ChatTitlebar, SessionList, ChatThread,
  chat-stream-manager, WorkspacePanel, Providers, UpdateSection).
  Pattern: replace with `catch (e)` and inline
  `const message = e instanceof Error ? e.message : String(e)`.
  AbortError checks use `e instanceof Error && e.name === 'AbortError'`.
- **Vendor globals → `src/types/dom.d.ts`.** Augment `Window` with
  `SpeechRecognition`, `webkitSpeechRecognition`, `__TAURI_INTERNALS__`,
  `hljs`. Define an internal `SpeechRecognitionLike` shape to avoid
  relying on the optional `lib.dom.d.ts` `SpeechRecognition` global.
  Six call sites in `liveSTT.ts`, `webSpeechSTT.ts`, `tauri-detect.ts`,
  `ChatMarkdown.tsx`, `ChatThread.tsx` updated to drop `(window as any)`.
- **Sweep `src/types/workbench.ts`.** Replace the 7 `any` slots:
  - `permissions` / `effectivePermissions` → `Record<string, unknown>`
  - `WorkbenchCapabilities.agents` → `Record<string, WorkbenchAgent>`
  - `WorkbenchBtwResult`: drop the `[key: string]: any` index signature;
    add optional `id`, `citations`, `confidence`.
  - `tool_use` / `tool_call` `input` → `Record<string, unknown>`.
  - `tool_result` / `onToolResult` `content` → `unknown` (was `any`).
  - `onWarning` / `onInfo`: replace `[k: string]: any` index with
    optional known fields + `extras?: Record<string, unknown>`.

### Phase 2 — Centralize chat types, narrow stream manager

- New **`src/types/chat.ts`** barrel with `ChatMessage`, `MessageBlock`,
  `FileAttachment`, `SubagentBlockState`, `ToolProgressEntry`,
  `WorkbenchBtwState`, `WorkbenchMode`, `EffortLevel`,
  `ChatMessageTodo`, `ChatMessageClarify`, `AppendBlockEvent`.
- `ChatThread.tsx` and `chat-stream-manager.ts` import from the new
  barrel; the local definitions are removed and re-exported for
  backward compatibility.
- `chat-stream-manager.ts`: 19 `any` → 0 (workbenchMode, effort,
  ensureWorkbenchSession, updater pattern via new `applyUpdater<T>`
  helper, subagent tool call/result input/content).
- `makeStreamHandlers.ts`: 7 `any` → 0 (WorkbenchBtwState, ChatTurnRecord,
  AppendBlockEvent).
- `EffortLevel` extended to include `'max'` (existing code already used
  it).
- `FileAttachment.path` added (was implicit via the now-deleted local
  definition).

### Phase 3 — Centralize API row types — **DEFERRED**

The proposed extraction of all 30+ interfaces from `api-client.ts` into
`src/types/api.ts` was deferred: the disruption (replacing every
internal `export interface` with a re-export, removing the originals,
and updating 29 downstream imports) outweighed the value when Zod
schemas (Phase 5) already define the canonical shapes at the runtime
boundary. Phase 5 is where the API contract is now formally defined.

### Phase 4 — Backend residual narrowing

Add four new TypedDicts to `app/typeAliases.py` (renamed from `types.py`
during Phase 0 because the file shadowed stdlib `types`):

- `BlackboardNoteDict` — `id`, `sessionId`, `agent`, `key`, `value`,
  `priority`, `createdAt`, `expiresAt`.
- `BrainEventMetaDict` — free-form counts/ids; consumers narrow via
  `as` because the shape is heterogeneous across subsystems.
- `ConsolidationSummaryDict` — `merged`, `promoted`, `deleted_stale`,
  `heuristics`, `durationMs`, `errors`.
- `DaemonStatusDict` — `id`, `name`, `status`, `startedAt`,
  `lastHeartbeat`, `extras`.

Narrow four services:
- `brainEventBus.py`: `dict[str, object]` → `dict[str, JsonValue]`
  across `emit`, `recent`, `stream`, `emitBrainEvent`.
- `blackboardService.py`: `readNotes()` → `list[BlackboardNoteDict]`.
- `consolidationDaemon.py`: `runConsolidation()` →
  `ConsolidationSummaryDict`.
- `daemonManager.py`: `listDaemons()` → `list[DaemonStatusDict]`.

### Phase 5 — Zod runtime validation at the SSE boundary

Add Zod schemas for the Workbench SSE event stream:
`frontend/desktop/src/api/schemas/workbench.ts` defines one schema per
`WorkbenchEvent` variant, joined via `z.discriminatedUnion('type')`.

Wire the schema into `api/workbench.ts` via a
`validateWorkbenchEvent()` helper that runs `safeParse` and logs a
console warning on mismatch (rather than throwing). The SSE stream
stays resilient to minor backend drift; a warning is the signal to
update either the schema or the corresponding TS type.

### Phase 6 — Documentation & tests

- This design doc.
- `frontend/desktop/src/api/schemas/__tests__/workbench.test.ts`:
  round-trip tests for every `WorkbenchEvent` variant, plus
  drift-detection tests for missing fields and unknown types.
- `docs/DEVELOPER_GUIDE.md` "Type Safety" section codifying the
  conventions (no `Any`, no `any` outside the SSE parser boundary,
  catch uses `unknown` + narrow, vendor globals in `dom.d.ts`).

## Verification

Per phase:

| Phase | Backend (mypy + pytest) | Frontend (tsc + vitest + eslint) |
|---|---|---|
| 0 | mypy runs (1980 pre-existing errors from active refactor) | ESLint surfaces 1186 issues — the work for Phases 1-3 |
| 1 | n/a | 23 pre-existing tsc errors, no regressions; 423/423 vitest |
| 2 | n/a | Same |
| 3 | n/a | DEFERRED |
| 4 | 1980 → 1971 mypy errors (9 fewer); main app imports cleanly | n/a |
| 5 | n/a | Same |
| 6 | n/a | vitest schema tests pass; this doc committed |

## Decisions Log

- **mypy over pyright:** the `python-backend` branch is already using
  mypy strict; switching to pyright would conflict with active work.
- **`JsonValue` for free-form JSON:** when a payload is genuinely
  heterogeneous (e.g. `brainEventBus.meta`), prefer `JsonValue` over a
  single TypedDict with `extras: JsonValue` to avoid accidental narrow
  contracts.
- **`unknown` over `Record<string, unknown>` for tool content:** tool
  results can be strings, arrays of content blocks, or objects —
  `unknown` is the honest type. Consumers narrow with Zod schemas
  before use.
- **Zod warnings, not throws:** the SSE stream must stay alive across
  transient drift. Console warnings feed into Phase 7's monitoring
  hooks.
- **No OpenAPI/codegen:** out of scope. Manual mirroring between
  `app/typeAliases.py` TypedDicts and frontend interfaces continues;
  Zod schemas are the runtime guard against drift.