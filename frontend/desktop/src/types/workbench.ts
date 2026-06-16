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
  onPrompt?: (data: { content: string; systemPrompt?: string; userMessage?: string; tokens?: number }) => void;
  onDone?: () => void;
  onError?: (data: { message: string }) => void;
}
