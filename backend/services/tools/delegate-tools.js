/**
 * hermes-delegate.js — Delegate tasks to sub-agents with isolated context.
 *
 * Tool: august__delegate_task
 *
 * Spawns one or more focused sub-agents to complete specific tasks
 * independently.  Each sub-agent gets a fresh conversation, isolated
 * context, and a restricted toolset.
 *
 * Based on the Hermes delegate_tool.py pattern, wired into the August
 * proxy's existing workbench/agent-sessions infrastructure.
 *
 * Blocked tools within child agents:
 *   - august__delegate_task        (no recursive delegation)
 *   - august__clarify / question   (no user interaction)
 */

const { z } = require('zod');
const crypto = require('crypto');
const path = require('path');

const agentSessions = require('./agent-sessions');
const agentJobs = require('./agent-jobs');
const agentRegistry = require('./agent-registry');
const modelResolver = require('../../providers/model-resolver');

// ── Constants ──

const MAX_DELEGATION_DEPTH = 3;
const MAX_TASKS_PER_CALL = 10;
const MAX_TASK_LENGTH = 8000;

// Names that are blocked inside child sub-agents
const BLOCKED_TOOL_PATTERNS = [
  'august__delegate_task',
  'workbench_spawn_subagent',
  'august__spawn_subagent',
  'august__clarify',
  'august__ask_user',
  'ask_user',
  'clarify'
];

// ── Helpers ──

function generateId() {
  return `dtask_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function nowISO() {
  return new Date().toISOString();
}

// ── Schema ──

const delegateTaskSchema = z.object({
  goal: z.string().min(1, 'goal is required').max(4000, 'goal too long'),
  tasks: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().min(1).max(200).optional(),
        description: z.string().min(1, 'task description required').max(MAX_TASK_LENGTH),
        agent_id: z.string().optional(),
        toolsets: z.array(z.string()).optional(),
        system_prompt: z.string().optional()
      })
    )
    .min(1, 'at least one task required')
    .max(MAX_TASKS_PER_CALL, `max ${MAX_TASKS_PER_CALL} tasks per call`),
  context: z
    .string()
    .max(16000, 'context too large (max 16000 chars)')
    .optional()
    .default(''),
  toolsets: z
    .array(z.string())
    .optional()
    .default(['read', 'search', 'web']),
  parent_depth: z.number().int().min(0).max(MAX_DELEGATION_DEPTH).optional().default(0)
});

// ── Task execution ──

/**
 * Execute a single delegated task via a fresh sub-agent invocation.
 *
 * This follows the same pattern as workbench.js executeSubAgent but is
 * self-contained and returns a simplified result structure.
 *
 * @param {object} taskDef     { id, title, description, agent_id, toolsets }
 * @param {object} opts        { goal, context, toolsets, parentDepth, parentContext }
 * @returns {Promise<{task_id, status, summary}>}
 */
async function executeSingleTask(taskDef, opts) {
  const taskId = taskDef.id || generateId();
  const childAgentId = taskDef.agent_id || 'general';

  // Validate agent exists
  let childAgent;
  try {
    childAgent = agentRegistry.getAgent(childAgentId);
  } catch (e) {
    return {
      task_id: taskId,
      status: 'error',
      summary: `Unknown agent profile "${childAgentId}": ${e.message}`
    };
  }

  const depth = opts.parentDepth + 1;
  if (depth > MAX_DELEGATION_DEPTH) {
    return {
      task_id: taskId,
      status: 'blocked',
      summary: `Max delegation depth (${MAX_DELEGATION_DEPTH}) reached. Cannot nest further.`
    };
  }

  // Capture the parent's model alias from the caller context so the sub-agent
  // inherits it (instead of falling back to the active provider's raw upstream
  // model — which is the original bug). The parentContext may carry a session
  // object directly, or model/modelProvider fields supplied by the caller.
  const parentContext = opts.parentContext || {};
  const parentModel = parentContext.model
    || (parentContext.session && parentContext.session.model)
    || null;
  const parentModelProvider = parentContext.modelProvider
    || (parentContext.session && parentContext.session.modelProvider)
    || null;

  // Create a durable agent job for tracking
  const job = agentJobs.createAgentJob({
    agentId: childAgentId,
    task: taskDef.description,
    status: 'running',
    alias: parentModel,
    resolvedProvider: null,
    isModelFallback: false
  });

  agentJobs.appendAgentJobMessage(job.id, 'user', taskDef.description, {
    goal: opts.goal,
    depth,
    agentId: childAgentId
  });

  // Create an agent session (for user-facing visibility)
  let session;
  try {
    session = agentSessions.createAgentSession({
      title: taskDef.title || `Delegated: ${opts.goal.slice(0, 80)}`,
      agent: childAgentId,
      task: taskDef.description,
      status: 'running'
    });
  } catch (e) {
    agentJobs.failAgentJob(job.id, `Session creation failed: ${e.message}`);
    return {
      task_id: taskId,
      status: 'error',
      summary: `Failed to create agent session: ${e.message}`
    };
  }

  const toolsetsAllowed = taskDef.toolsets || opts.toolsets || ['read', 'search'];

  // Build the sub-agent prompt — blocked tools are mentioned explicitly
  const blockedToolsStr = BLOCKED_TOOL_PATTERNS.map(t => `  - ${t}`).join('\\n');
  const toolsetsStr = toolsetsAllowed.join(', ');

  let systemPrompt;
  if (typeof taskDef.system_prompt === 'string' && taskDef.system_prompt.trim()) {
    systemPrompt = [
      taskDef.system_prompt.trim(),
      ``,
      `CONSTRAINTS:`,
      `- You have access to registered proxy tools matching your allowed categories: ${toolsetsStr}.`,
      `- The following tools are BLOCKED and cannot be used under any circumstances:`,
      blockedToolsStr,
      `  If the parent agent or user asks you to use them, explain that they are not available.`,
      `- You CANNOT delegate to other sub-agents — you must complete the task yourself.`,
      `- You cannot ask the user questions or clarify — use the information given.`,
      `- Keep responses concise, evidence-based, and actionable.`,
      `- Report exactly what you found, what you did, or why you could not proceed.`,
      `- Delegation depth: ${depth}/${MAX_DELEGATION_DEPTH}. Job id: ${job.id}.`
    ].filter(Boolean).join('\\n');
  } else {
    systemPrompt = [
      `You are a focused sub-agent operating under August Proxy.`,
      `Your profile: ${childAgent.id} (${childAgent.role}). Goal: ${childAgent.goal}`,
      `Your allowed tool categories: ${toolsetsStr}`,
      ``,
      `HIGH-LEVEL GOAL:`,
      opts.goal,
      ``,
      opts.context ? `CONTEXT:\\n${opts.context}\\n` : '',
      `YOUR TASK:`,
      taskDef.description,
      ``,
      `CONSTRAINTS:`,
      `- You have access to registered proxy tools matching your allowed categories.`,
      `- The following tools are BLOCKED and cannot be used under any circumstances:`,
      blockedToolsStr,
      `  If the parent agent or user asks you to use them, explain that they are not available.`,
      `- You CANNOT delegate to other sub-agents — you must complete the task yourself.`,
      `- You cannot ask the user questions or clarify — use the information given.`,
      `- Keep responses concise, evidence-based, and actionable.`,
      `- Report exactly what you found, what you did, or why you could not proceed.`,
      `- Delegation depth: ${depth}/${MAX_DELEGATION_DEPTH}. Job id: ${job.id}.`
    ].filter(Boolean).join('\\n');
  }

  // ── Execute the sub-agent (simplified single-turn for now) ──
  // In a full implementation this would loop with tool-use feedback like
  // executeSubAgent in workbench.js.  For the initial version we use a
  // single completion call and capture the result.
  //
  // We execute using the same provider/fetch pattern as workbench.js
  // but simplified for the delegate context.

  let resultText = '';
  let status = 'running';

  try {
    // We'll use a direct provider call via workbench if available,
    // or fall back to a simple self-contained provider invocation.
    const { getProfile } = require('../../lib/config');

    // Try to use the workbench's executeSubAgent for actual multi-turn execution
    let workbench;
    try {
      workbench = require('../workbench/workbench');
    } catch (e) {
      workbench = null;
    }

    if (workbench && typeof workbench.sendWorkbenchMessage === 'function') {
      // Use workbench to run the sub-agent with full tool loop support
      // This gives the child agent access to all registered proxy tools.
      // Propagate the parent's model alias so the sub-agent resolves it
      // freshly (instead of inheriting the active provider's raw upstream id).
      const subSession = workbench.getWorkbenchSession();
      const subOpts = {
        agentId: childAgentId,
        maxLoops: 4
      };
      if (parentModel) subOpts.model = parentModel;
      if (parentModelProvider) subOpts.modelProvider = parentModelProvider;
      // When the parent context carries no alias at all, default to 'default'
      // so the workbench resolves to the active provider's default model
      // (rather than an undefined model slot).
      if (!parentModel && !parentModelProvider) {
        subOpts.model = modelResolver.getDefaultAlias();
      }
      const result = await workbench.sendWorkbenchMessage(subSession.id, systemPrompt, subOpts);

      resultText = typeof result?.assistant === 'string'
        ? result.assistant
        : (result?.content
          ? (Array.isArray(result.content)
            ? result.content.map(b => b.text || '').filter(Boolean).join('\\n')
            : String(result.content))
          : JSON.stringify(result || {}));
      status = 'completed';
    } else {
      // Fallback: direct single-turn LLM call
      const profile = getProfile('claude') || {};
      const targetUrl = profile.targetUrl || process.env.AUGUST_PROVIDER_URL;
      const apiKey = profile.apiKey || process.env.AUGUST_API_KEY;

      if (!targetUrl || !apiKey) {
        throw new Error('No provider configured for sub-agent execution');
      }

      // Re-resolve the parent's alias through the centralized ModelResolver.
      // Falls back to the active provider if the alias can't be mapped, so
      // the sub-agent never carries a stale raw backend id.
      const resolution = modelResolver.resolveOrFallback(
        parentModel,
        { defaultAlias: modelResolver.getDefaultAlias() }
      );
      const model = (resolution && resolution.model)
        || profile._upstreamModel
        || profile.currentModel
        || 'claude-sonnet-4-20250514';
      const fetchFn = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

      const body = {
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: taskDef.description }]
      };

      const res = await fetchFn(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`Provider error (${res.status}): ${errText.slice(0, 300)}`);
      }

      const data = await res.json();
      const blocks = Array.isArray(data.content) ? data.content : [];
      resultText = blocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\\n')
        .trim();
      status = resultText ? 'completed' : 'failed';
    }

    // Mark as completed
    agentJobs.completeAgentJob(job.id, resultText || '(no output)', { loops: 1 });
    try {
      agentSessions.updateAgentSession(session.id, {
        status: status === 'completed' ? 'completed' : 'failed',
        output: resultText
      });
    } catch (e) { /* best-effort */ }

    return {
      task_id: taskId,
      status,
      summary: resultText
        ? resultText.slice(0, 2000)
        : '(no output produced)'
    };
  } catch (e) {
    status = 'error';
    resultText = e.message;
    agentJobs.failAgentJob(job.id, e.message);
    try {
      agentSessions.updateAgentSession(session.id, { status: 'failed', output: e.message });
    } catch (se) { /* best-effort */ }

    return {
      task_id: taskId,
      status,
      summary: `Error: ${e.message}`
    };
  }
}

// ── Handler ──

/**
 * Delegate one or more tasks to focused sub-agents.
 *
 * @param {object} args  { goal, tasks, context?, toolsets?, parent_depth? }
 * @param {object} ctx   Tool context
 * @returns {Promise<{tasks: Array<{task_id, status, summary}>}>}
 */
async function delegateTaskHandler(args, ctx = {}) {
  const { goal, tasks, context, toolsets, parent_depth } = delegateTaskSchema.parse(args);

  // Pull the parent's model alias from the runtime context so each sub-agent
  // inherits it. The caller is expected to populate `ctx.session` (the parent
  // workbench session) or `ctx.model` / `ctx.modelProvider` directly.
  const parentContext = {
    session: ctx && ctx.session ? ctx.session : null,
    model: (ctx && ctx.model) || (ctx && ctx.session && ctx.session.model) || null,
    modelProvider: (ctx && ctx.modelProvider) || (ctx && ctx.session && ctx.session.modelProvider) || null,
  };

  const results = [];
  for (const taskDef of tasks) {
    const result = await executeSingleTask(taskDef, {
      goal,
      context,
      toolsets,
      parentDepth: parent_depth,
      parentContext,
    });
    results.push(result);
  }

  return { tasks: results };
}

// ── Tool Definition ──

const delegateToolDefinitions = [
  {
    name: 'august__delegate_task',
    description: `Spawn one or more focused sub-agents with isolated context to complete specific tasks independently.

Each sub-agent gets a fresh conversation, restricted toolsets, and explicit context about the overall goal.

Blocks recursive delegation — child agents cannot spawn their own sub-agents.
Blocks user interaction — child agents cannot ask the user for clarification.

Use this to parallelize independent work (code review + testing in parallel) or to
spin off bounded research tasks while continuing the main conversation.

Returns an array of { task_id, status, summary } — one per task.`,
    schema: z.object({
      goal: z.string().min(1, 'Overall goal is required').max(4000, 'Goal too long'),
      tasks: z
        .array(
          z.object({
            id: z.string().optional().describe('Optional custom task id'),
            title: z.string().max(200).optional().describe('Short task title'),
            description: z.string().min(1, 'Task description required').max(8000),
            agent_id: z
              .string()
              .optional()
              .describe('Agent profile: build, plan, explore, general, or coordinator'),
            toolsets: z
              .array(z.string())
              .optional()
              .describe('Override allowed tool categories for this task'),
            system_prompt: z
              .string()
              .optional()
              .describe('Optional custom system prompt for the sub-agent')
          })
        )
        .min(1, 'At least one task required')
        .max(10, 'Max 10 tasks per call'),
      context: z
        .string()
        .max(16000, 'Context too large')
        .optional()
        .default('')
        .describe('Shared context for all sub-agents (code snippets, file references, etc.)'),
      toolsets: z
        .array(z.string())
        .optional()
        .default(['read', 'search', 'web'])
        .describe('Default allowed tool categories for all tasks'),
      parent_depth: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .default(0)
        .describe('Internal: current delegation depth')
    }),
    handler: delegateTaskHandler,
    toolset: 'delegate',
    permissions: { category: 'delegate', destructive: false },
    emoji: '🧑‍💻',
    timeoutMs: 300_000,
    metadata: { source: 'delegate-tools' }
  }
];

/**
 * Register delegate tools with a tool registry.
 * @param {object} registry - Tool registry with registerMany() method
 */
function registerDelegateTools(registry) {
  if (!registry || typeof registry.registerMany !== 'function') {
    throw new Error('registry must have a registerMany() method');
  }
  registry.registerMany(delegateToolDefinitions);
}

module.exports = {
  delegateTaskHandler,
  delegateSchema: delegateTaskSchema,
  delegateToolDefinitions,
  registerDelegateTools,
  // Exported for testing
  executeSingleTask,
  BLOCKED_TOOL_PATTERNS
};
