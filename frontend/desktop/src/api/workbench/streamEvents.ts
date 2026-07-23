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
    case 'toolResult':
      handlers.onToolResult?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        content: p?.content,
        isError: p?.isError as boolean | undefined,
        providerSetup: p?.providerSetup,
      });
      break;
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
    case 'checkpoint':
      handlers.onCheckpoint?.({
        id: typeof p?.id === 'string' ? p.id : undefined,
        label: typeof p?.label === 'string' ? p.label : undefined,
        fileCount: Number(p?.fileCount) || undefined,
        toolName: typeof p?.toolName === 'string' ? p.toolName : undefined,
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
    case 'userMessageQueued':
      handlers.onUserMessageQueued?.({
        sessionId: typeof p?.sessionId === 'string' ? p.sessionId : JSON.stringify(p?.sessionId ?? ''),
        messageId: typeof p?.messageId === 'string' ? p.messageId : JSON.stringify(p?.messageId ?? ''),
        text: typeof p?.text === 'string' ? p.text : JSON.stringify(p?.text ?? ''),
        queuedAt: typeof p?.queuedAt === 'string' ? p.queuedAt : new Date().toISOString(),
      });
      break;
    case 'userMessageDequeued':
      handlers.onUserMessageDequeued?.({
        sessionId: typeof p?.sessionId === 'string' ? p.sessionId : JSON.stringify(p?.sessionId ?? ''),
        messageId: typeof p?.messageId === 'string' ? p.messageId : JSON.stringify(p?.messageId ?? ''),
      });
      break;
    case 'userMessageInjected':
      handlers.onUserMessageInjected?.({
        sessionId: typeof p?.sessionId === 'string' ? p.sessionId : JSON.stringify(p?.sessionId ?? ''),
        messageId: typeof p?.messageId === 'string' ? p.messageId : JSON.stringify(p?.messageId ?? ''),
        text: typeof p?.text === 'string' ? p.text : JSON.stringify(p?.text ?? ''),
        queuedAt: typeof p?.queuedAt === 'string' ? p.queuedAt : new Date().toISOString(),
      });
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
      });
      break;
    case 'subagentDone':
      handlers.onSubagentDone?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        status: (['completed', 'failed', 'cancelled'].includes(p?.status as string)
          ? (p.status as 'completed' | 'failed' | 'cancelled')
          : 'completed'),
        message: p?.message as string | undefined,
        result: p?.result as string | undefined,
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
    case 'subagentText':
      handlers.onSubagentText?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        content: typeof p?.content === 'string' ? p.content : JSON.stringify(p?.content ?? ''),
      });
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
    case 'subagentToolResult':
      handlers.onSubagentToolResult?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        content: p?.content,
        isError: p?.isError as boolean | undefined,
        status: p?.isError ? 'error' : 'done',
      });
      break;
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
    case 'done': {
      const u = p?.usage;
      handlers.onDone?.({
        usage: u
          ? {
              inputTokens: Number((u as Record<string, unknown>).inputTokens) || 0,
              outputTokens: Number((u as Record<string, unknown>).outputTokens) || 0,
              contextTokens: Number((u as Record<string, unknown>).contextTokens) || 0,
            }
          : undefined,
      });
      break;
    }
    case 'error':
      handlers.onError?.({ message: typeof p?.message === 'string' ? p.message : JSON.stringify(p?.message ?? 'Unknown error') });
      break;
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
