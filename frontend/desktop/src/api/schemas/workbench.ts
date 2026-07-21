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
  sessionId: z.string(),
  model: z.string(),
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
});

export const WorkbenchToolCallEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('toolCall'),
  id: z.string(),
  name: z.string(),
  input: UnknownDictSchema.optional(),
  status: z.string().optional(),
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
  providerSetup: z.unknown().optional(),
});

const WorkbenchSessionSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  provider: z.string(),
  agentId: z.string(),
  agentRole: z.string(),
  agentMode: z.string(),
  approved: z.boolean(),
  approvedAt: z.string().nullable(),
  plan: z.unknown().nullable(),
  goal: z.unknown().nullable(),
  lastGoal: z.unknown().nullable(),
  messageCount: z.number(),
  mutationCount: z.number(),
  lastMutationAt: z.string().nullable(),
  updatedAt: z.string(),
  todos: z.array(z.unknown()),
  guardMode: z.enum(['plan', 'full', 'ask', 'edit']),
  sandboxMode: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .or(z.string())
    .optional(),
  sandboxNetwork: z.boolean().optional(),
  workspacePath: z.string().optional(),
});

export const WorkbenchSessionEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('session'),
  data: WorkbenchSessionSchema,
});

const WorkbenchBtwResultSchema = z.object({
  answer: z.string(),
  id: z.string().optional(),
  citations: z.array(z.string()).optional(),
  confidence: z.number().optional(),
});

export const WorkbenchBtwEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('btw'),
  data: WorkbenchBtwResultSchema,
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
  data: z.record(z.never()).optional(),
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

/** Event emitted for browser automation actions. */
export const WorkbenchBrowserActionEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('browserAction'),
  id: z.string().optional(),
  name: z.string().optional(),
  input: UnknownDictSchema.optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  target: z.string().optional(),
  screenshot: z.string().optional(),
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
  agentId: z.string(),
  jobId: z.string(),
  name: z.string(),
  role: z.string(),
  goal: z.string(),
});

export const WorkbenchSubagentTextEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentText'),
  agentId: z.string(),
  jobId: z.string(),
  content: z.string(),
});

export const WorkbenchSubagentToolCallEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentToolCall'),
  agentId: z.string(),
  jobId: z.string(),
  id: z.string(),
  name: z.string(),
  input: UnknownDictSchema,
});

export const WorkbenchSubagentToolResultEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentToolResult'),
  agentId: z.string(),
  jobId: z.string(),
  id: z.string(),
  name: z.string(),
  content: z.string(),
  status: z.string().optional(),
});

export const WorkbenchSubagentDoneEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('subagentDone'),
  agentId: z.string(),
  jobId: z.string().optional(),
  status: z.string(),
  error: z.string().optional(),
  result: z.string().optional(),
  isFallback: z.boolean().optional(),
});

/** Warning events (e.g. model fallback notices) */
export const WorkbenchWarningEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('warning'),
  kind: z.string(),
  agentId: z.string().optional(),
  message: z.string(),
});

/** User-message-injected event (from queued messages) */
export const WorkbenchUserMessageInjectedEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('userMessageInjected'),
  content: z.string().optional(),
  text: z.string().optional(),
});

/** Auto-memory recall visibility — emitted once per turn right after
 *  buildSystemPrompt() prefetches relevant `auto_memories` rows. */
export const WorkbenchRecalledMemoriesEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('recalledMemories'),
  items: z.array(
    z.object({
      id: z.string().optional(),
      key: z.string().optional(),
      category: z.string().optional(),
      snippet: z.string().optional(),
    }),
  ),
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
  WorkbenchWarningEventSchema,
  WorkbenchUserMessageInjectedEventSchema,
  WorkbenchRecalledMemoriesEventSchema,
]);

/** Inferred TypeScript type — should match `WorkbenchEvent` from
 *  `@/types/workbench`. Use this when you need a Zod-derived type and
 *  don't want to import the hand-written interface. */
export type WorkbenchEventFromSchema = z.infer<typeof WorkbenchEventSchema>;
