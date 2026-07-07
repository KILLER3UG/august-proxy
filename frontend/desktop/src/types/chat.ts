/* ── Chat domain types ─────────────────────────────────────────────────
 * Mirrors the backend's chat message and sub-agent state shapes. These
 * are deliberately split out from `workbench.ts` because the chat layer
 * has its own internal block-rendering pipeline (MessageBlock) that's
 * orthogonal to the WorkbenchEvent SSE union.
 */

/** Rendered block inside a chat message (thinking, tool call, etc.).
 *  Kept as a permissive interface rather than a discriminated union so
 *  the existing reducer and rendering pipeline can attach fields like
 *  `isRevisedPlan` and `tool` to any block kind. Consumers should
 *  narrow on `type` before relying on a specific field shape. */
export interface MessageBlock {
  id: string;
  type: 'thinking' | 'toolCall' | 'command' | 'finalOutput';
  content?: string;
  tool?: MessageBlockToolCall;
  /** Set on toolCall blocks whose context represents a revised plan
   *  (august__submit_plan with isRevisedPlan=true). */
  isRevisedPlan?: boolean;
}

export interface MessageBlockToolCall {
  id: string;
  name: string;
  context?: string;
  args?: string;
  preview?: string;
  summary?: string;
  error?: string;
  status: 'running' | 'done' | 'error';
  duration?: number;
  startedAt?: number;
  /** For web_search results: structured search hits rendered as a linked
   *  list below the tool summary. Mirrors `AppendBlockEvent.searchHits`. */
  searchHits?: Array<{ title: string; url: string; snippet?: string }>;
  pendingApproval?: {
    message?: string;
    detail?: string;
    confirmationToken?: string;
  };
}

export interface FileAttachment {
  name: string;
  size: string;
  /** Full filesystem path when running under Tauri with a directory
   *  picker; absent in pure-browser uploads. */
  path?: string;
  /** Extracted text content for text-type files (PDF, DOCX, code, etc.) */
  content?: string;
  /** Base64 data URL for images. */
  dataUrl?: string;
  /** Whether the file content was successfully extracted. */
  type: 'text' | 'image' | 'unsupported';
  /** True if content was truncated due to size limits. */
  truncated?: boolean;
}

export interface ChatMessageTodo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export interface ChatMessageClarify {
  question?: string;
  choices?: string[];
  /** Multi-question flow; wins over the legacy `question`/`choices` when present. */
  questions?: Array<{ question: string; choices?: string[] }>;
  /** 0-indexed; managed by the popup. */
  currentIndex?: number;
  /** Header line above the question (e.g. "Synthesized user context to craft …"). */
  contextSummary?: string;
  answer?: string;
}

/** Full chat message shape used by ChatThread. The optional fields are
 *  layered: most messages just need `id`, `role`, `content`, `timestamp`.
 *  Inline cards, attachments, and tool calls hang off the same record. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string;
  /** Optional message kind. Used for special rendering (e.g. 'help' panel,
   *  registry-driven inline cards, subagent approval cards). */
  kind?: 'help' | 'voice-command-card' | 'subagent-approval';
  /** When kind === 'voice-command-card', the registry id of the command. */
  commandId?: string;
  /** Optional context payload for inline cards and approvals. */
  context?: Record<string, unknown>;
  /** Work breakdown items for kind === 'subagent-approval'. */
  breakdown?: Array<{ goal: string; restrictedTools?: string[] }>;
  attachments?: FileAttachment[];
  tool?: {
    name: string;
    args?: string;
    status: 'running' | 'done' | 'error';
    duration?: number;
    result?: string;
  };
  tools?: Array<{
    name: string;
    context?: string;
    id: string;
    status: 'running' | 'done' | 'error';
    summary?: string;
    error?: string;
    preview?: string;
    duration?: number;
    startedAt?: number;
    /** For web_search: structured search hits to render below the summary. */
    searchHits?: Array<{ title: string; url: string; snippet?: string }>;
  }>;
  thinking?: string;
  thinkingDuration?: number;
  /** True when this user message was delivered mid-response as a queued
   *  follow-up (the user kept typing while the model was working). The
   *  UI renders a small "Queued" badge so the conversation flow makes
   *  it clear that the message arrived without interrupting the prior
   *  turn. */
  queued?: boolean;
  /** Hoisted todo panel */
  todos?: ChatMessageTodo[];
  /** Inline Workbench mutation summary shown after the final response. */
  changedFiles?: unknown; // GitDiffResult — defined in lib/git; kept loose to avoid cycles
  /** Inline clarify/question */
  clarify?: ChatMessageClarify;
  blocks?: MessageBlock[];
}

/** Per-session sub-agent container rendered nested under the parent
 *  toolCall. Each sub-agent has its own block timeline. */
export interface SubagentBlockState {
  id: string;
  jobId: string;
  parentToolId: string;
  agentId: string;
  scope?: string;
  task?: string;
  depth?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  /** Inner blocks (thinking/text/toolCall/toolResult) — same shape as
   *  the parent message's blocks. */
  blocks: MessageBlock[];
  error?: string;
}

/** Tool progress entry used by the streaming layer. Kept loose (`status`
 *  is two-state because the chat UI only flips between reading→read). */
export interface ToolProgressEntry {
  path: string;
  status: 'reading' | 'read';
}

/** Workbench btw ("by the way") answer. Mirrors the backend SSE payload;
 *  the `id` is used by the drawer to reset its question input. */
export interface WorkbenchBtwState {
  id?: string;
  answer: string;
  citations?: string[];
  confidence?: number;
}

/** Mode of Workbench execution. */
export type WorkbenchMode = 'plan' | 'full' | 'ask';

/** Reasoning effort level for chat turns. Includes `max` because some
 *  backends (Anthropic extended thinking) accept it as an alternative
 *  to `high`; keeping it in the union avoids runtime casts. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/** Event payload accepted by `appendBlockEvent`. Broader than the SSE
 *  `WorkbenchEvent` union because the reducer also handles locally
 *  synthesized events (`command`, `finalOutput`, `tool_progress`)
 *  that don't cross the wire. */
export interface AppendBlockEvent {
  type:
    | 'thinking'
    | 'text'
    | 'content'
    | 'finalOutput'
    | 'toolCall'
    | 'command'
    | 'tool_progress'
    | 'toolResult';
  content?: string;
  name?: string;
  id?: string;
  context?: string;
  preview?: string;
  summary?: string;
  error?: string;
  status?: 'running' | 'done' | 'error';
  duration?: number;
  isRevisedPlan?: boolean;
  /** For web_search results: structured search hits to render as linked list */
  searchHits?: Array<{ title: string; url: string; snippet?: string }>;
}