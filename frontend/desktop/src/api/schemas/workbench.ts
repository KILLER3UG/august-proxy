/* ── Workbench Zod schemas ────────────────────────────────────────────
 * Runtime validation for the Workbench SSE event stream. Mirrors the
 * `WorkbenchEvent` discriminated union in `@/types/workbench`; the
 * schema and the type should be kept in sync by hand (a CI step that
 * auto-generates one from the other is a Phase 7 candidate).
 *
 * The schema uses Zod's discriminated union on the `type` field, so a
 * schema mismatch from the backend produces a focused error message
 * pointing at the offending variant.
 */

import { z } from 'zod';

/** A free-form JSON object; matches the structural type used by
 *  tool_use.input / tool_call.input. */
const UnknownDictSchema = z.record(z.unknown());

/** Generic content for tool_result events; the backend sends arbitrary
 *  JSON for these and we narrow at the consumer. */
const ToolResultContentSchema = z.unknown();

const WorkbenchBaseSchema = z.object({
  /** Per-event sequence id (used for SSE reconnect via `sinceSeq`). */
  id: z.string().optional(),
});

export const WorkbenchThinkingEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('thinking'),
  data: z.object({ content: z.string() }),
});

export const WorkbenchTextEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('text'),
  data: z.object({ content: z.string() }),
});

export const WorkbenchContentEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('content'),
  data: z.object({ content: z.string() }),
});

export const WorkbenchToolUseEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('tool_use'),
  data: z.object({
    id: z.string(),
    name: z.string(),
    input: UnknownDictSchema,
  }),
});

export const WorkbenchToolCallEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('tool_call'),
  data: z.object({
    id: z.string(),
    name: z.string(),
    input: UnknownDictSchema.optional(),
  }),
});

export const WorkbenchToolResultEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('tool_result'),
  data: z.object({
    id: z.string(),
    content: ToolResultContentSchema,
    is_error: z.boolean().optional(),
  }),
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
  guardMode: z.enum(['plan', 'full', 'ask']),
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
  data: z.object({
    headCount: z.number(),
    tailCount: z.number(),
    compressedCount: z.number(),
    originalTokens: z.number(),
    compressedTokens: z.number(),
    underThreshold: z.boolean().optional(),
    threshold: z.number().optional(),
  }),
});

export const WorkbenchDoneEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('done'),
  data: z.record(z.never()),
});

export const WorkbenchErrorEventSchema = WorkbenchBaseSchema.extend({
  type: z.literal('error'),
  data: z.object({ message: z.string() }),
});

export const WorkbenchEventSchema = z.discriminatedUnion('type', [
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
]);

/** Inferred TypeScript type — should match `WorkbenchEvent` from
 *  `@/types/workbench`. Use this when you need a Zod-derived type and
 *  don't want to import the hand-written interface. */
export type WorkbenchEventFromSchema = z.infer<typeof WorkbenchEventSchema>;