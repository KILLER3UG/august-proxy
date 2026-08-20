# Review Follow-Up: Two Required Fixes (Telemetry Data Flow)

**Context:** Review of `docs/INCREMENT_BENCHMARK_TELEMETRY_SKILLCHIP_PLAN.md`
implementation. Increments A and C passed review. Increment B's backend is
complete, but the frontend data flow has two gaps that break its acceptance
criteria. Both are localized to `makeStreamHandlers.ts` +
`ChatThreadMessagePane.tsx`.

**Already fixed by the reviewer (do not re-do):** three tsc errors —
`api.get` extra headers arg in `previewSkillFromEpisode`, missing
`'skill_suggestion'` in the `BrainEvent` category union
(`src/api/api-client/brain.ts`), and `activeSessionId` → `sessionId` in
`ChatThread.tsx`.

---

## Fix 1 — Wire backend tool timing through to the waterfall

**Problem:** `streamEvents.ts` parses `durationMs` / `startedAtMs` / `blocked`
off `toolResult` events, but `makeStreamHandlers.ts:391` destructures only
`{ id, content, isError, status, providerSetup, integrationSetup }` — the new
fields are dropped. The handler instead computes client-side
`duration: Date.now() - t.startedAt` (includes SSE transport latency) and
never records `blocked`.

Downstream, `ChatThreadMessagePane.tsx:143` detects blocked tools via
`t.status === 'error' && summary.includes('[Blocked]')` — but the backend
emits blocked results with `status: 'done'`, so the handler never marks them
as errors and **blocked tools can never render distinctly in the waterfall**
(an explicit acceptance criterion).

**Required changes:**

1. `makeStreamHandlers.ts` `onToolResult`: destructure `durationMs`,
   `startedAtMs`, `blocked` and store them on the tool entry:
   - `duration: durationMs ?? (t.startedAt ? Date.now() - t.startedAt : undefined)`
     (prefer the authoritative backend value, keep the client fallback for
     old backends/replayed sessions)
   - `startedAt: startedAtMs ?? t.startedAt`
   - `blocked: blocked === true`
2. `ChatThreadMessagePane.tsx` toolTimings mapping: use the stored fields
   directly — `blocked: t.blocked === true` (drop the
   `status === 'error' && '[Blocked]'` heuristic entirely),
   `startedAtMs: t.startedAt`, `durationMs: t.duration`.
3. Extend the tool entry type in `src/types/chat.ts` (or wherever the tool
   result shape lives) with `blocked?: boolean` if not already present.

**Verify:** in a benchmark-mode session, attempt a disallowed tool; the
waterfall must render it as a blocked (amber, zero-width) marker.

---

## Fix 2 — Feed the telemetry bar its missing metrics

**Problem:** `ChatThreadMessagePane.tsx` passes only `ttftMs` and
`toolTimings` to `RunTelemetryBar`. `cacheHitRate`, `outputTokens`,
`durationMs`, and `roundCount` are never wired, so three of the four headline
metrics never render in production (the component test passes only because it
supplies props directly).

**Data sources (all already available):**

- The `done` event's usage is already stored on the assistant message:
  `makeStreamHandlers.ts:799` (`turnUsage = data?.usage`) → message field
  `usage` (line ~218). So `lastAssistant.usage` carries `outputTokens`,
  `durationMs`, `cacheHitTokens`, `cacheMissTokens`.
- Session-level `cacheHitRate`: `useChatUsage(sessionId, ...)` from
  `src/sections/chat/hooks/useChatUsage.ts` (already used by
  `ComposerToolbar.tsx:453`).

**Required changes in `ChatThreadMessagePane.tsx`:**

```tsx
<RunTelemetryBar
  sessionId={sessionId}
  cacheHitRate={sessionUsage?.cacheHitRate ?? null}   // from useChatUsage
  ttftMs={perf?.ttftMs}
  outputTokens={lastAssistant?.usage?.outputTokens ?? null}
  durationMs={lastAssistant?.usage?.durationMs ?? null}
  roundCount={/* count of tool rounds in lastAssistant?.tools, or omit */}
  toolTimings={toolTimings}
  streaming={streaming}
/>
```

- Add the `useChatUsage` hook call (it needs the workbench session id —
  follow `ComposerToolbar`'s usage pattern).
- Prefer the per-turn `usage.cacheHitTokens / (cacheHitTokens +
  cacheMissTokens)` when present for the *turn's* rate; fall back to the
  session-level `cacheHitRate`.
- `roundCount` is optional: derive from `lastAssistant?.tools?.length` only
  if cheap; otherwise leave it out (the bar hides it when absent).

**Verify:** after a normal agent turn with tool calls, the bar shows cache %,
TTFT, and tokens/sec — not just TTFT.

---

## Out of scope (do not address in this pass)

- The retry-streaming rearchitecture (live streaming + rollback on
  `retrying`) — flagged for manual QA of a forced mid-stream retry, but not
  part of this fix list.
- The bundled extras (`needs-attention` endpoint, `ProducedFilesRow`,
  harness trace client, model-profile/evidence event wiring) — accepted
  as-is pending separate review.

## Validation before resubmit

```bash
cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q
npm run test:frontend
cd frontend/desktop && npx tsc --noEmit   # vitest does NOT type-check
```
