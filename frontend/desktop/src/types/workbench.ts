/* Workbench types — mirror backend/services/workbench/workbench.js */

export interface WorkbenchTodo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface WorkbenchPlan {
  id: string;
  summary: string;
  steps: string[];
  files: string[];
  risks: string[];
  verification: string[];
  markdown?: string;
  createdAt: string;
}

export interface WorkbenchGoal {
  id: string;
  condition: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  achievedAt: string | null;
  clearedAt: string | null;
  turns: number;
  lastReason: string | null;
  lastMet: boolean;
}

export type WorkbenchGuardMode = 'plan' | 'full' | 'ask';

export interface WorkbenchSession {
  id: string;
  title?: string;
  provider: string;
  agentId: string;
  agentRole: string;
  agentMode: string;
  approved: boolean;
  approvedAt: string | null;
  plan: WorkbenchPlan | null;
  goal: WorkbenchGoal | null;
  lastGoal: WorkbenchGoal | null;
  messageCount: number;
  mutationCount: number;
  lastMutationAt: string | null;
  updatedAt: string;
  todos: WorkbenchTodo[];
  guardMode: WorkbenchGuardMode;
}

export interface WorkbenchAgent {
  id: string;
  role: string;
  mode: string;
  goal: string;
  scopes: string[];
  team: boolean;
  teamSkills: Array<{
    name: string;
    description: string;
    trigger: string;
    ownerAgentId: string;
    scope: string;
  }>;
  memoryEnabled: boolean;
  canCrossLoadTeamSkills: boolean;
  allowDelegation: boolean;
  tools: string[];
  permissions: Record<string, any>;
  inheritedFrom: string | null;
  effectivePermissions: Record<string, any>;
}

export interface WorkbenchAgentRegistry {
  generatedAt: string;
  activeAgentId: string;
  agents: WorkbenchAgent[];
  inheritance: {
    rule: string;
    parentAgentId: string;
  };
}

export interface WorkbenchCapability {
  name: string;
  mutating: boolean;
  description: string;
}

export interface WorkbenchCapabilities {
  generatedAt: string;
  totalTools: number;
  groups: Record<string, WorkbenchCapability[]>;
  agents: any;
  approvalGate: {
    readSearchInspectAllowed: boolean;
    mutationsRequireApprovedPlan: boolean;
  };
}

export interface WorkbenchBtwResult {
  answer: string;
  [key: string]: any;
}

export type WorkbenchEvent =
  | { type: 'thinking'; data: { content: string } }
  | { type: 'text'; data: { content: string } }
  | { type: 'content'; data: { content: string } }
  | { type: 'tool_use'; data: { id: string; name: string; input: Record<string, any> } }
  | { type: 'tool_call'; data: { id: string; name: string; input?: Record<string, any> } }
  | { type: 'tool_result'; data: { id: string; content: any; is_error?: boolean } }
  | { type: 'session'; data: WorkbenchSession }
  | { type: 'btw'; data: WorkbenchBtwResult }
  | { type: 'compaction'; data: { headCount: number; tailCount: number; compressedCount: number; originalTokens: number; compressedTokens: number; underThreshold?: boolean; threshold?: number } }
  | { type: 'done'; data: Record<string, never> }
  | { type: 'error'; data: { message: string } };

export interface WorkbenchEventHandlers {
  onThinking?: (data: { content: string }) => void;
  onText?: (data: { content: string }) => void;
  onToolUse?: (data: { id: string; name: string; input: Record<string, any> }) => void;
  onToolResult?: (data: { id: string; content: any; is_error?: boolean }) => void;
  onToolProgress?: (data: {
    id: string;
    name: string;
    phase: 'reading' | 'read' | 'running' | 'done' | 'error';
    paths?: string[];
    path?: string;
    message?: string;
  }) => void;
  onSession?: (data: WorkbenchSession) => void;
  onBtw?: (data: WorkbenchBtwResult) => void;
  onCompaction?: (data: {
    headCount: number;
    tailCount: number;
    compressedCount: number;
    originalTokens: number;
    compressedTokens: number;
    underThreshold?: boolean;
    threshold?: number;
  }) => void;
  onPrompt?: (data: {
    content: string;
    systemPrompt?: string;
    userMessage?: string;
    tokens?: number;
    /** ID of the parent tool_use block (august__spawn_subagent / august__run_team)
     *  that triggered the sub-agent whose prompt is being disclosed. Used by
     *  the chat thread to attach the disclosure to the right tool call card. */
    toolUseId?: string;
    /** Sub-agent profile id (e.g. "general", "researcher") that this prompt
     *  was assembled for. */
    subagentId?: string;
    /** Durable job id of the sub-agent run, if available. */
    jobId?: string;
  }) => void;
  /**
   * Emitted exactly once when the backend registers a new chat turn for
   * the session. The `sinceSeq` is the seq the live SSE stream will start
   * from — clients use it to attach via `sinceSeq=` on reconnect so they
   * don't replay events they've already consumed.
   */
  onStarted?: (data: { sinceSeq?: number }) => void;
  /** Fired once per `id:` SSE frame so the subscriber can record the
   *  highest seq it has consumed (used for `sinceSeq` on reconnect). */
  onSeq?: (seq: number) => void;
  /** Emitted when a sub-agent (`august__spawn_subagent` / `august__run_team`)
   *  begins. The chat thread renders a nested sub-agent block under the
   *  matching parent `tool_call`, keyed by `parentToolUseId`. */
  onSubagentStart?: (data: {
    jobId: string;
    agentId: string;
    parentJobId?: string | null;
    parentToolUseId?: string;
    scope?: string;
    depth?: number;
    task?: string;
  }) => void;
  /** Emitted when a sub-agent finishes. `status` is `completed` / `failed`
   *  / `cancelled` (the last mirrors the parent turn's aborted state). */
  onSubagentDone?: (data: {
    jobId: string;
    agentId: string;
    status: 'completed' | 'failed' | 'cancelled';
    message?: string;
    result?: string;
  }) => void;
  /** Text block emitted from inside a running sub-agent. Rendered as a
   *  `final_output` block inside the matching nested sub-agent block. */
  onSubagentText?: (data: {
    jobId: string;
    agentId: string;
    content: string;
  }) => void;
  /** Tool call inside a running sub-agent. Rendered as a `tool_call`
   *  block inside the matching nested sub-agent block. */
  onSubagentToolCall?: (data: {
    jobId: string;
    agentId: string;
    id: string;
    name: string;
    input: Record<string, any>;
    status?: 'running' | 'done' | 'error';
  }) => void;
  /** Tool result for a sub-agent tool call. Collapses the matching
   *  `tool_call` to its final state. */
  onSubagentToolResult?: (data: {
    jobId: string;
    agentId: string;
    id: string;
    content: any;
    is_error?: boolean;
    status?: 'done' | 'error';
  }) => void;
  /** Generic warnings (e.g. model fallback when a sub-agent alias couldn't
   *  be resolved). */
  onWarning?: (data: {
    kind?: string;
    message?: string;
    jobId?: string;
    toolUseId?: string;
    [k: string]: any;
  }) => void;
  onDone?: () => void;
  onError?: (data: { message: string }) => void;
}
