/* Named SSE event dispatch for Workbench chat streams.
 * Maps backend event: frames (text, toolUse, done, …) onto WorkbenchEventHandlers.
 * Frames are soft-validated against WorkbenchEventSchema so minor drift logs a
 * warning without dropping the stream. */

import type {
  WorkbenchSession,
  WorkbenchBtwResult,
  WorkbenchEventHandlers,
} from '@/types/workbench';
import { WorkbenchEventSchema } from '../schemas/workbench';

/** Soft-validate an SSE frame against the WorkbenchEvent Zod schema.
 *  Logs a console warning on mismatch (instead of throwing) so the stream
 *  stays resilient to minor backend drift. A mismatch here is a signal
 *  to update the schema or the corresponding TypeScript type. */
export function validateWorkbenchEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  const result = WorkbenchEventSchema.safeParse({ type: event, ...payload });
  if (!result.success) {
    console.warn(
      `[workbench] SSE event '${event}' failed schema validation:`,
      result.error.issues.slice(0, 3),
    );
  }
}

/** Route a single named SSE event + JSON payload to the matching handler. */
export function dispatchWorkbenchEvent(
  event: string,
  payload: Record<string, unknown>,
  handlers: WorkbenchEventHandlers
): void {
  validateWorkbenchEvent(event, payload);
  const p = payload;
  switch (event) {
    case 'thinking':
      handlers.onThinking?.({ content: typeof p?.content === 'string' ? p.content : JSON.stringify(p?.content ?? '') });
      break;
    case 'text':
    case 'content':
    case 'finalOutput':
    case 'final_output': // legacy snake_case alias
      handlers.onText?.({ content: typeof p?.content === 'string' ? p.content : JSON.stringify(p?.content ?? '') });
      break;
    case 'toolUse':
      handlers.onToolUse?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        name: typeof p?.name === 'string' ? p.name : JSON.stringify(p?.name ?? ''),
        input: (p?.input as Record<string, unknown>) ?? {},
      });
      break;
    case 'toolCall': {
      let input: Record<string, unknown> = {};
      try {
        input = typeof p?.input === 'string' ? (JSON.parse(p.input) as Record<string, unknown>) : ((p?.input as Record<string, unknown>) ?? {});
      } catch {
        input = {};
      }
      handlers.onToolUse?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        name: typeof p?.name === 'string' ? p.name : JSON.stringify(p?.name ?? ''),
        input,
      });
      break;
    }
    case 'toolResult': {
      const content = p?.content;
      const status = typeof p?.status === 'string' ? p.status : undefined;
      const resultText =
        typeof content === 'string'
          ? content
          : content != null
            ? JSON.stringify(content)
            : '';
      // The backend never sends `isError` — the authoritative signal is the
      // `status` field ('done' today; failures begin with `Error:` text).
      const isError =
        p?.isError === true ||
        (status !== undefined && status !== 'done') ||
        /^Error:/i.test(resultText);
      handlers.onToolResult?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        content,
        isError,
        status,
        providerSetup: p?.providerSetup,
        integrationSetup: p?.integrationSetup,
      });
      break;
    }
    case 'tool_progress': {
      const phase = (typeof p?.phase === 'string' ? p.phase : JSON.stringify(p?.phase ?? 'done')) as 'reading' | 'read' | 'running' | 'done' | 'error';
      handlers.onToolProgress?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        name: typeof p?.name === 'string' ? p.name : JSON.stringify(p?.name ?? ''),
        phase,
        paths: Array.isArray(p?.paths) ? (p.paths as string[]) : undefined,
        path: typeof p?.path === 'string' ? p.path : undefined,
        message: typeof p?.message === 'string' ? p.message : undefined,
        preview: typeof p?.preview === 'string' ? p.preview : undefined,
      });
      break;
    }
    case 'session':
      handlers.onSession?.(p as unknown as WorkbenchSession);
      break;
    case 'btw':
      handlers.onBtw?.(p as unknown as WorkbenchBtwResult);
      break;
    case 'compaction':
      handlers.onCompaction?.({
        headCount: Number(p?.headCount) || 0,
        tailCount: Number(p?.tailCount) || 0,
        compressedCount: Number(p?.compressedCount) || 0,
        originalTokens: Number(p?.originalTokens) || 0,
        compressedTokens: Number(p?.compressedTokens) || 0,
        underThreshold: p?.underThreshold === true,
        threshold: Number(p?.threshold) || undefined,
        contextWindow: Number(p?.contextWindow) || undefined,
      });
      break;
    case 'prompt':
      handlers.onPrompt?.({
        content: typeof p?.content === 'string' ? p.content : JSON.stringify(p?.content ?? ''),
        systemPrompt: p?.systemPrompt as string | undefined,
        userMessage: p?.userMessage as string | undefined,
        tokens: p?.tokens as number | undefined,
        toolUseId: p?.toolUseId as string | undefined,
        subagentId: p?.subagentId as string | undefined,
        jobId: p?.jobId as string | undefined,
      });
      break;
    case 'started':
      handlers.onStarted?.({ sinceSeq: p?.sinceSeq as number | undefined });
      break;
    // Snake_case spellings the workbench emits for the same lifecycle —
    // both names dispatch to the same camelCase handlers.
    case 'user_message_queued':
    case 'userMessageQueued':
      handlers.onUserMessageQueued?.({
        sessionId: typeof p?.sessionId === 'string' ? p.sessionId : JSON.stringify(p?.sessionId ?? ''),
        messageId: typeof p?.messageId === 'string' ? p.messageId : JSON.stringify(p?.messageId ?? ''),
        text: typeof p?.text === 'string' ? p.text : JSON.stringify(p?.text ?? ''),
        queuedAt: typeof p?.queuedAt === 'string' ? p.queuedAt : new Date().toISOString(),
      });
      break;
    case 'user_message_dequeued':
    case 'userMessageDequeued':
      handlers.onUserMessageDequeued?.({
        sessionId: typeof p?.sessionId === 'string' ? p.sessionId : JSON.stringify(p?.sessionId ?? ''),
        messageId: typeof p?.messageId === 'string' ? p.messageId : JSON.stringify(p?.messageId ?? ''),
      });
      break;
    case 'user_message_injected':
    case 'userMessageInjected':
      handlers.onUserMessageInjected?.({
        sessionId: typeof p?.sessionId === 'string' ? p.sessionId : JSON.stringify(p?.sessionId ?? ''),
        messageId: typeof p?.messageId === 'string' ? p.messageId : JSON.stringify(p?.messageId ?? ''),
        text: typeof p?.text === 'string' ? p.text : JSON.stringify(p?.text ?? ''),
        queuedAt: typeof p?.queuedAt === 'string' ? p.queuedAt : new Date().toISOString(),
      });
      break;
    // Queue reorder / update / clear and todo/checkpoint lifecycle: accepted
    // (no schema-mismatch warning) but no dedicated UI handler yet.
    case 'user_message_queue_reordered':
    case 'user_message_queue_updated':
    case 'user_message_queue_cleared':
    case 'todosUpdated':
    case 'checkpoint':
      break;
    case 'subagentStart':
      handlers.onSubagentStart?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        parentJobId: p?.parentJobId !== undefined ? (typeof p.parentJobId === 'string' ? p.parentJobId : JSON.stringify(p.parentJobId)) : null,
        parentToolUseId: p?.parentToolUseId as string | undefined,
        scope: p?.scope as string | undefined,
        depth: Number.isFinite(Number(p?.depth)) ? Number(p.depth) : undefined,
        task: p?.task as string | undefined,
        workstream: typeof p?.workstream === 'string' ? p.workstream : undefined,
      });
      break;
    case 'subagentDone':
      handlers.onSubagentDone?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        // Backend statuses: completed | failed | error | blocked | partial |
        // cancelled | recovered. Coercing error/blocked/partial to completed
        // hid failures as successes — pass them through so the UI can render
        // them honestly.
        status: (['completed', 'failed', 'cancelled', 'error', 'blocked', 'partial', 'recovered'].includes(
          p?.status as string,
        )
          ? (p.status as 'completed' | 'failed' | 'cancelled' | 'error' | 'blocked' | 'partial' | 'recovered')
          : 'failed'),
        // Failure reasons arrive in `error` (executeSubAgent path) or
        // `message` (orchestrator path) — surface whichever is present.
        message: (p?.message as string | undefined) ?? (p?.error as string | undefined),
        result: p?.result as string | undefined,
        workstream: typeof p?.workstream === 'string' ? p.workstream : undefined,
      });
      break;
    case 'subagentProposed':
      handlers.onSubagentProposed?.({
        proposalId: typeof p?.proposalId === 'string' ? p.proposalId : '',
        workBreakdown: Array.isArray(p?.workBreakdown) ? (p.workBreakdown as Array<{ goal?: string; agentId?: string }>) : [],
      });
      break;
    case 'warning':
      handlers.onWarning?.({
        kind: p?.kind as string | undefined,
        message: p?.message as string | undefined,
        jobId: p?.jobId as string | undefined,
        toolUseId: p?.toolUseId as string | undefined,
        ...p,
      });
      break;
    case 'info':
      handlers.onInfo?.({
        message: typeof p?.message === 'string' ? p.message : undefined,
        extras: p as Record<string, unknown>,
      });
      break;
    case 'subagentText':
      handlers.onSubagentText?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        content: typeof p?.content === 'string' ? p.content : JSON.stringify(p?.content ?? ''),
      });
      break;
    case 'subagentRetry':
      // Transient upstream error inside a sub-agent — the worker backs off
      // and retries. Rendered as a notice inside the nested sub-agent block
      // (applySubagentEvent).
      handlers.onSubagentRetry?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        attempt: typeof p?.attempt === 'number' ? p.attempt : Number(p?.attempt) || undefined,
        maxRetries: typeof p?.maxRetries === 'number' ? p.maxRetries : Number(p?.maxRetries) || undefined,
        message: p?.message as string | undefined,
      });
      break;
    case 'subagentWarning':
      // Warning scoped to a sub-agent run (e.g. fallback alias resolution).
      // No dedicated nested container — surface via onWarning so the parent
      // turn shows a system notice.
      handlers.onWarning?.({
        kind: p?.kind as string | undefined,
        message: p?.message as string | undefined,
        jobId: p?.jobId as string | undefined,
        toolUseId: p?.toolUseId as string | undefined,
        ...p,
      });
      break;
    case 'memoryUpdated':
      // Harness changed long-term memory (remember / update / forget) — the
      // chat renders an inline "August remembered…" notice.
      handlers.onMemoryUpdated?.({
        action: typeof p?.action === 'string' ? p.action : undefined,
        summary: typeof p?.summary === 'string' ? p.summary : undefined,
      });
      break;
    case 'evidenceState':
      // TODO: backend emits evidence-state snapshots for the verifier /
      // routing evidence UI. No consumer exists yet (ChatThread has no
      // evidence panel) — acknowledged, not dropped with a schema warning.
      break;
    case 'modelProfileSuggestion':
      // TODO: backend emits per-model capability suggestions (toolSurface,
      // maxTools, …). No consumer exists yet — acknowledged, not dropped
      // with a schema warning.
      break;
    case 'subagentToolCall':
      handlers.onSubagentToolCall?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        name: typeof p?.name === 'string' ? p.name : JSON.stringify(p?.name ?? ''),
        input: (p?.input as Record<string, unknown>) ?? {},
        status: p?.status as 'running' | 'done' | 'error' | undefined,
      });
      break;
    case 'subagentToolResult': {
      const content = p?.content;
      const backendStatus = typeof p?.status === 'string' ? p.status : undefined;
      const resultText =
        typeof content === 'string'
          ? content
          : content != null
            ? JSON.stringify(content)
            : '';
      // Backend statuses pass through; anything other than 'done' is an
      // error (the backend never sends `isError` — failures begin with
      // `Error:` text).
      const failed =
        (backendStatus !== undefined && backendStatus !== 'done') ||
        p?.isError === true ||
        /^Error:/i.test(resultText);
      handlers.onSubagentToolResult?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        content,
        isError: failed,
        status: failed ? 'error' : 'done',
      });
      break;
    }
    case 'aborted':
      handlers.onDone?.();
      break;
    case 'browserAction':
      handlers.onBrowserAction?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        name: typeof p?.name === 'string' ? p.name : JSON.stringify(p?.name ?? ''),
        input: (p?.input as Record<string, unknown>) ?? {},
        url: p?.url as string | undefined,
        title: p?.title as string | undefined,
        target: (p?.target as { x: number; y: number; width: number; height: number } | null) ?? null,
        screenshot: (p?.screenshot as { path: string; width: number; height: number } | null) ?? null,
        typed: p?.typed as string | undefined,
        selected: p?.selected as string | undefined,
        scrolled: p?.scrolled as string | undefined,
        status: p?.status === 'error' ? 'error' : 'success',
      });
      break;
    case 'verifierBlocked':
      handlers.onVerifierBlocked?.({
        message:
          typeof p?.message === 'string'
            ? p.message
            : 'Verification required before the final answer is shown',
        evidence: p?.evidence as
          | {
              currentPhase?: string;
              verificationCommand?: string;
              blockers?: string[];
              completed?: string[];
              receiptCount?: number;
            }
          | undefined,
      });
      break;
    case 'routingSuggestion':
      handlers.onRoutingSuggestion?.({
        applied: p?.applied === true,
        taskType: typeof p?.taskType === 'string' ? p.taskType : '',
        model: typeof p?.model === 'string' ? p.model : '',
        provider: typeof p?.provider === 'string' ? p.provider : '',
        winRate: typeof p?.winRate === 'number' ? p.winRate : 0,
        gap: typeof p?.gap === 'number' ? p.gap : undefined,
        currentModel: typeof p?.currentModel === 'string' ? p.currentModel : undefined,
        reason: typeof p?.reason === 'string' ? p.reason : undefined,
      });
      break;
    case 'recurringTask':
      handlers.onRecurringTask?.({
        message: typeof p?.message === 'string' ? p.message : '',
      });
      break;
    case 'contextPressure': {
      const pressureLevel =
        typeof p?.attentionPressure === 'string' ? p.attentionPressure : '';
      handlers.onContextPressure?.({
        contextUsedPct: typeof p?.contextUsedPct === 'number' ? p.contextUsedPct : undefined,
        attentionPressure: ['low', 'medium', 'high', 'critical'].includes(pressureLevel)
          ? (pressureLevel as 'low' | 'medium' | 'high' | 'critical')
          : undefined,
        totalTokens: typeof p?.totalTokens === 'number' ? p.totalTokens : undefined,
        maxContext: typeof p?.maxContext === 'number' ? p.maxContext : undefined,
        remainingTokens:
          typeof p?.remainingTokens === 'number' ? p.remainingTokens : undefined,
      });
      break;
    }
    case 'done': {
      const u = p?.usage;
      const durationRaw = Number((u as Record<string, unknown> | undefined)?.durationMs);
      handlers.onDone?.({
        usage: u
          ? {
              inputTokens: Number((u as Record<string, unknown>).inputTokens) || 0,
              outputTokens: Number((u as Record<string, unknown>).outputTokens) || 0,
              contextTokens: Number((u as Record<string, unknown>).contextTokens) || 0,
              durationMs: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : undefined,
            }
          : undefined,
        usedFallback:
          typeof p?.usedFallback === 'string' ? p.usedFallback : undefined,
        // Forwarded so the live context badge + memory-suggestion chips
        // actually arrive (audit finding: they were dropped here).
        context: p?.context as
          | {
              profileSummaryUsed?: boolean;
              heuristicsUsed?: number;
              addedMemories?: number;
              recalledMemories?: Array<{ key?: string; category?: string; snippet?: string }>;
              currentContextUsed?: boolean;
              activeProjects?: number;
              coreFactsUsed?: boolean;
              augDirectiveUsed?: boolean;
            }
          | undefined,
        memorySuggestions: Array.isArray(p?.memorySuggestions)
          ? (p.memorySuggestions as string[]).filter((s): s is string => typeof s === 'string')
          : undefined,
      });
      break;
    }
    case 'error':
      handlers.onError?.({ message: typeof p?.message === 'string' ? p.message : JSON.stringify(p?.message ?? 'Unknown error') });
      break;
    case 'retrying': {
      const attempt = Number(p?.attempt) || 0;
      const maxRetries = Number(p?.maxRetries) || 0;
      const delayMs = Number(p?.delayMs) || 0;
      handlers.onRetrying?.({
        attempt,
        maxRetries,
        delayMs,
        reason: typeof p?.reason === 'string' ? p.reason : 'Provider error',
      });
      break;
    }
    case 'clarifyProposed': {
      const c = (p?.clarify ?? {}) as Record<string, unknown>;
      handlers.onClarifyProposed?.({
        question: typeof c?.question === 'string' ? c.question : undefined,
        choices: Array.isArray(c?.choices) ? (c.choices as string[]) : undefined,
        questions: Array.isArray(c?.questions)
          ? (c.questions as Array<{ question: string; choices?: string[] }>)
          : undefined,
        currentIndex: typeof c?.currentIndex === 'number' ? c.currentIndex : undefined,
        contextSummary: typeof c?.contextSummary === 'string' ? c.contextSummary : undefined,
      });
      break;
    }
    case 'planProposed':
      handlers.onPlanProposed?.({ plan: p?.plan });
      break;
    case 'guardModeChanged':
      if (typeof p?.guardMode === 'string' && p.guardMode) {
        handlers.onGuardModeChanged?.({
          guardMode: p.guardMode,
          agentId: typeof p?.agentId === 'string' ? p.agentId : undefined,
        });
      }
      break;
    case 'recalledMemories': {
      const items = Array.isArray(p?.items) ? (p.items as Record<string, unknown>[]) : [];
      handlers.onRecalledMemories?.({
        items: items.map((it) => ({
          id: typeof it?.id === 'string' ? it.id : '',
          key: typeof it?.key === 'string' ? it.key : '',
          category: typeof it?.category === 'string' ? it.category : 'auto',
          snippet: typeof it?.snippet === 'string' ? it.snippet : '',
        })),
      });
      break;
    }
  }
}
