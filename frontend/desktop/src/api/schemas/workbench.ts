/* ── Workbench Zod schemas ────────────────────────────────────────────
 * Runtime validation for the Workbench SSE event stream. Mirrors the
 * `WorkbenchEvent` discriminated union in `@/types/workbench`; the
 * schema and the type should be kept in sync by hand (a CI step that
 * auto-generates one from the other is a Phase 7 candidate).
 *
 * The schema uses Zod's discriminated union on the `type` field, so a
 * schema mismatch from the backend produces a focused error message
 * pointing at the offending variant.
 *
 * NOTE: The backend sends events as flat key-value JSON (no `data`
 * wrapper). Each schema below defines its fields at the top level.
 */

import { z } from 'zod';

/** A free-form JSON object; matches the structural type used by
 *  toolUse.input / toolCall.input. */
const UnknownDictSchema = z.record(z.unknown());

/** Generic content for toolResult events; the backend sends arbitrary
 *  JSON for these and we narrow at the consumer. */
const ToolResultContentSchema = z.unknown();

const WorkbenchBaseSchema = z.object({
  /** Per-event sequence id (used for SSE reconnect via `sinceSeq`). */
  id: z.string().optional(),
});

export const WorkbenchStartedEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('started'),
  // The first `started` frame the backend logs is `{'sinceSeq': 0}` — the
  // sessionId/model fields only appear on later turns. Both optional.
  sessionId: z.string().optional(),
  model: z.string().optional(),
  sinceSeq: z.number().optional(),
});

export const WorkbenchThinkingEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('thinking'),
  content: z.string(),
});

export const WorkbenchTextEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('text'),
  content: z.string(),
});

export const WorkbenchContentEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('content'),
  content: z.string(),
});

export const WorkbenchToolUseEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('toolUse'),
  id: z.string(),
  name: z.string(),
  input: UnknownDictSchema,
  startedAtMs: z.number().optional(),
});

export const WorkbenchToolCallEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('toolCall'),
  id: z.string(),
  name: z.string(),
  input: UnknownDictSchema.optional(),
  status: z.string().optional(),
  startedAtMs: z.number().optional(),
});

export const WorkbenchToolResultEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('toolResult'),
  id: z.string(),
  name: z.string(),
  content: ToolResultContentSchema,
  contentTruncated: z.boolean().optional(),
  contentFullLength: z.number().optional(),
  summary: z.string().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
  startedAtMs: z.number().optional(),
  blocked: z.boolean().optional(),
  providerSetup: z.unknown().optional(),
  integrationSetup: z.unknown().optional(),
});

/** Session snapshots are FLAT (no `data:` wrapper) and may be partial —
 *  the backend streams whatever fields changed, and the dispatcher narrows
 *  via normalizeWorkbenchSession. All fields optional so a minimal
 *  `{type: 'session', id}` frame still validates. */
export const WorkbenchSessionEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('session'),
  id: z.string().optional(),
  title: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  agentId: z.string().optional(),
  agentRole: z.string().optional(),
  agentMode: z.string().optional(),
  approved: z.boolean().optional(),
  approvedAt: z.string().nullable().optional(),
  plan: z.unknown().nullable().optional(),
  goal: z.unknown().nullable().optional(),
  lastGoal: z.unknown().nullable().optional(),
  messageCount: z.number().optional(),
  mutationCount: z.number().optional(),
  lastMutationAt: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  todos: z.array(z.unknown()).optional(),
  guardMode: z.string().optional(),
  sandboxMode: z.string().optional(),
  sandboxNetwork: z.boolean().optional(),
  workspacePath: z.string().optional(),
  costCeiling: z.number().optional(),
});

/** BTW results are flat too (no `data:` wrapper). */
export const WorkbenchBtwEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('btw'),
  id: z.string().optional(),
  answer: z.string().optional(),
  citations: z.array(z.string()).optional(),
  confidence: z.number().optional(),
});

export const WorkbenchCompactionEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('compaction'),
  headCount: z.number(),
  tailCount: z.number(),
  compressedCount: z.number(),
  originalTokens: z.number(),
  compressedTokens: z.number(),
  underThreshold: z.boolean().optional(),
  threshold: z.number().optional(),
  contextWindow: z.number().optional(),
});

export const WorkbenchDoneEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('done'),
  sessionId: z.string().optional(),
  /** Per-turn token usage (absent on early-exit done events). */
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      contextTokens: z.number(),
    })
    .optional(),
});

export const WorkbenchErrorEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('error'),
  message: z.string(),
});

/** Event emitted when the backend sends a plan proposal. */
export const WorkbenchPlanProposedEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('planProposed'),
  plan: z.unknown(),
});

/** Event emitted when the model asks a clarifying question (it was uncertain). */
export const WorkbenchClarifyProposedEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('clarifyProposed'),
  clarify: z
    .object({
      question: z.string().optional(),
      choices: z.array(z.string()).optional(),
      questions: z
        .array(z.object({ question: z.string(), choices: z.array(z.string()).optional() }))
        .optional(),
      currentIndex: z.number().optional(),
      contextSummary: z.string().optional(),
    })
    .optional(),
});

/** Event emitted for browser automation actions. `target` and `screenshot`
 *  are OBJECTS parsed from the browser tool result (not strings). */
export const WorkbenchBrowserActionEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('browserAction'),
  id: z.string().optional(),
  name: z.string().optional(),
  input: UnknownDictSchema.optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  target: z.unknown().optional(),
  screenshot: z.unknown().optional(),
  typed: z.string().optional(),
  selected: z.string().optional(),
  scrolled: z.string().optional(),
  status: z.string().optional(),
});

/** Event emitted for final output content. */
export const WorkbenchFinalOutputEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('finalOutput'),
  content: z.string(),
});

/** Sub-agent events */
export const WorkbenchSubagentStartEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentStart'),
  agentId: z.string().optional(),
  jobId: z.string(),
  task: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  goal: z.string().optional(),
  worktreePath: z.unknown().optional(),
  isolated: z.boolean().optional(),
});

export const WorkbenchSubagentTextEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentText'),
  agentId: z.string().optional(),
  jobId: z.string(),
  content: z.string(),
});

export const WorkbenchSubagentToolCallEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentToolCall'),
  agentId: z.string().optional(),
  jobId: z.string(),
  id: z.string(),
  name: z.string(),
  input: UnknownDictSchema,
});

export const WorkbenchSubagentToolResultEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentToolResult'),
  agentId: z.string().optional(),
  jobId: z.string(),
  id: z.string(),
  name: z.string(),
  content: z.string(),
  status: z.string().optional(),
});

export const WorkbenchSubagentDoneEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentDone'),
  agentId: z.string().optional(),
  jobId: z.string().optional(),
  status: z.string(),
  error: z.string().optional(),
  message: z.string().optional(),
  result: z.string().optional(),
  isFallback: z.boolean().optional(),
});

/** User-approval proposal from spawn_subagents (mode='proposed') */
export const WorkbenchSubagentProposedEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentProposed'),
  proposalId: z.string(),
  workBreakdown: z.array(z.object({ goal: z.string().optional(), agentId: z.string().optional() })).optional(),
});

/** Warning events (e.g. model fallback notices) — the backend sends only
 *  `message`; `kind` is optional for legacy payloads. */
export const WorkbenchWarningEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('warning'),
  kind: z.string().optional(),
  agentId: z.string().optional(),
  jobId: z.string().optional(),
  toolUseId: z.string().optional(),
  message: z.string().optional(),
});

/** User-message-injected event (from queued messages) */
export const WorkbenchUserMessageInjectedEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('userMessageInjected'),
  content: z.string().optional(),
  text: z.string().optional(),
});

/** Auto-memory recall visibility — emitted once per turn right after

/** Queued-message lifecycle events. The workbench emits snake_case names for
 *  queue/dequeue/reorder while the dispatcher expects camelCase — both
 *  spellings are accepted so queue updates are never dropped or warned. */
export const WorkbenchUserMessageQueueEventSchema = WorkbenchBaseSchema.extend({
  type: z.enum([
    'user_message_queued',
    'user_message_dequeued',
    'user_message_injected',
    'user_message_queue_reordered',
    'user_message_queue_updated',
    'user_message_queue_cleared',
  ]),
});

/** Lifecycle events without dedicated UI handling yet (todo-list updates,
 *  filesystem checkpoints) — accepted so they don't trip the schema-mismatch
 *  warning in the stream dispatcher. `upstreamRetry` (Phase L) and
 *  `recalledMemories` (Part 17 A.4) route to handlers in streamEvents.ts.
 *  `turnTelemetry` (Phase L) is accepted here so the frame is not flagged as a
 *  mismatch, but streamEvents.ts has no `turnTelemetry` case yet — the event
 *  is currently dropped (no cache-hit/latency chip is wired). */
export const WorkbenchMiscLifecycleEventSchema = WorkbenchBaseSchema.extend({
  type: z.enum([
    'todosUpdated',
    'subagentTodos',
    'checkpoint',
    'aborted',
    'retrying',
    'upstreamRetry',
    'turnTelemetry',
    'recalledMemories',
  ]),
});

/** Legacy snake_case alias of `finalOutput` — some paths still emit it. */
export const WorkbenchLegacyFinalOutputEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('final_output'),
  content: z.string().optional(),
});

/** update_state phase/step transition — feeds the inline working strip. */
export const WorkbenchExecutionStateEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('executionState'),
  phase: z.string().optional(),
  step: z.number().optional(),
  completed: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
});

/** Recurring-task daemon (B7): a due reminder fired at turn start. */
export const WorkbenchRecurringTaskEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('recurringTask'),
  message: z.string().optional(),
});

/** /circuit workbench toggled for this session (panel open/close). */
export const WorkbenchCircuitModeEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('circuitMode'),
  active: z.boolean(),
  message: z.string().optional(),
  sessionId: z.string().optional(),
});

/** Routing-evidence consult (D1): a better model exists for the task type,

/** Live context-meter event — emitted once per turn (low/medium pressure is
 *  a gauge only; the UI warns on high/critical). */
export const WorkbenchContextPressureEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('contextPressure'),
  contextUsedPct: z.number().optional(),
  attentionPressure: z.string().optional(),
  totalTokens: z.number().optional(),
  maxContext: z.number().optional(),
  remainingTokens: z.number().optional(),
  promptCache: z.unknown().optional(),
});

/** The model switched the session into plan mode itself (enter_plan_mode). */
export const WorkbenchGuardModeChangedEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('guardModeChanged'),
  guardMode: z.string().optional(),
  agentId: z.string().optional(),
});

/** Harness changed long-term memory (remember / update / forget). */
export const WorkbenchMemoryUpdatedEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('memoryUpdated'),
  summary: z.string().optional(),
  content: z.string().optional(),
  key: z.string().optional(),
});

/** Per-turn evidence-state snapshot for the routing-evidence store. */

/** Per-model capability profile suggestion (toolSurface, maxTools, …). */

/** Transient upstream error inside a sub-agent — the worker backs off. */
export const WorkbenchSubagentRetryEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentRetry'),
  agentId: z.string().optional(),
  jobId: z.string().optional(),
  attempt: z.number().optional(),
  maxRetries: z.number().optional(),
  message: z.string().optional(),
});

/** Warning scoped to a sub-agent run (e.g. narrated tool call). */
export const WorkbenchSubagentWarningEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentWarning'),
  agentId: z.string().optional(),
  jobId: z.string().optional(),
  message: z.string().optional(),
});

export const WorkbenchEventSchema = z.discriminatedUnion('type', [
  WorkbenchStartedEventSchema,
  WorkbenchThinkingEventSchema,
  WorkbenchTextEventSchema,
  WorkbenchContentEventSchema,
  WorkbenchToolUseEventSchema,
  WorkbenchToolCallEventSchema,
  WorkbenchToolResultEventSchema,
  WorkbenchSessionEventSchema,
  WorkbenchBtwEventSchema,
  WorkbenchCompactionEventSchema,
  WorkbenchDoneEventSchema,
  WorkbenchErrorEventSchema,
  WorkbenchPlanProposedEventSchema,
  WorkbenchClarifyProposedEventSchema,
  WorkbenchBrowserActionEventSchema,
  WorkbenchFinalOutputEventSchema,
  WorkbenchSubagentStartEventSchema,
  WorkbenchSubagentTextEventSchema,
  WorkbenchSubagentToolCallEventSchema,
  WorkbenchSubagentToolResultEventSchema,
  WorkbenchSubagentDoneEventSchema,
  WorkbenchSubagentProposedEventSchema,
  WorkbenchWarningEventSchema,
  WorkbenchUserMessageInjectedEventSchema,
  WorkbenchExecutionStateEventSchema,
  WorkbenchRecurringTaskEventSchema,
  WorkbenchCircuitModeEventSchema,
  WorkbenchContextPressureEventSchema,
  WorkbenchGuardModeChangedEventSchema,
  WorkbenchSubagentRetryEventSchema,
  WorkbenchSubagentWarningEventSchema,
  WorkbenchMemoryUpdatedEventSchema,
  WorkbenchUserMessageQueueEventSchema,
  WorkbenchLegacyFinalOutputEventSchema,
  WorkbenchMiscLifecycleEventSchema,
]);

/** Inferred TypeScript type — should match `WorkbenchEvent` from
 *  `@/types/workbench`. Use this when you need a Zod-derived type and
 *  don't want to import the hand-written interface. */
export type WorkbenchEventFromSchema = z.infer<typeof WorkbenchEventSchema>;
