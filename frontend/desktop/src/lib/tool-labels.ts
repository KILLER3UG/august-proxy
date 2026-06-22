/**
 * Maps raw tool names to user-friendly display labels.
 * For dynamic labels (e.g. subagent), a function takes the tool context
 * and returns the label.
 */

const TOOL_LABEL_MAP: Record<string, string> = {
  // File operations
  'august__read_file': 'Reading file',
  'read_file': 'Reading file',
  'august_read': 'Reading file',
  'august__read': 'Reading file',
  'view_file': 'Reading file',

  'august__write_file': 'Writing file',
  'write_file': 'Writing file',
  'august_write': 'Writing file',
  'august__write': 'Writing file',
  'write_to_file': 'Writing file',

  'august__edit_file': 'Editing file',
  'edit_file': 'Editing file',
  'august_edit': 'Editing file',
  'august__edit': 'Editing file',
  'replace_file_content': 'Editing file',
  'multi_replace_file_content': 'Editing file',

  'august__replace_text': 'Replacing text',
  'replace_text': 'Replacing text',
  'august__create_file': 'Creating file',
  'create_file': 'Creating file',

  'august_delete': 'Deleting file',
  'august__delete': 'Deleting file',
  'delete_file': 'Deleting file',
  
  // Search & explore
  'august_search': 'Searching',
  'august__search': 'Searching',
  'august__grep': 'Searching files',
  'august__web_search': 'Web request',
  'web_search': 'Web request',
  'august__web_fetch': 'Web request',
  'web_fetch': 'Web request',
  'august__list_dir': 'Listing directory',
  'list_dir': 'Listing directory',
  'august__list_directory': 'Listing directory',
  'list_directory': 'Listing directory',
  'august__search_files': 'Searching files',
  'search_files': 'Searching files',
  'grep_search': 'Searching',
  'search_web': 'Searching',
  
  // Commands
  'august__run_command': 'Executing command',
  'run_command': 'Executing command',
  'august__bash': 'Executing command',
  'august_bash': 'Executing command',
  
  // Sub-agents & delegation
  'august__spawn_subagent': 'Subagent',
  'august_spawn_subagent': 'Subagent',
  'workbench_spawn_subagent': 'Subagent',
  'august__delegate_task': 'Delegating task',
  'august__run_team': 'Running team',
  'workbench_run_team': 'Running team',
  
  // Memory & knowledge
  'august__remember': 'Updating memory',
  'august__forget': 'Updating memory',
  'august__recall': 'Updating memory',
  'august_memory_write': 'Updating memory',
  'august__memory_write': 'Updating memory',

  // Web & API
  'august_web': 'Web request',
  'august__web': 'Web request',
  'august_api': 'API call',
  'august__api': 'API call',
  'read_url_content': 'Web request',
  'execute_url': 'Web request',
  
  // Planning
  'august__submit_plan': 'Submitting plan',
  'august__update_todos': 'Updating tasks',
  
  // Skills
  'august__load_skill': 'Loading skill',
  'august__learn_subagent': 'Learning patterns',
};

const AGENT_ROLE_LABELS: Record<string, string> = {
  explore: 'Explore',
  plan: 'Plan',
  build: 'Build',
  general: 'General',
  coordinator: 'Coordinator',
  project_manager: 'Project Manager',
  frontend_dev: 'Frontend',
  backend_dev: 'Backend',
  qa_tester: 'QA',
  documentation: 'Docs',
  deployment: 'Deploy',
};

/**
 * Resolve a sub-agent id (e.g. `qa_tester`, `frontend_dev`) to a friendly
 * role label (`QA`, `Frontend`). Falls back to a humanized version of the
 * raw id when no mapping exists.
 */
export function getAgentRoleLabel(agentId?: string): string {
  if (!agentId) return 'Agent';
  const direct = AGENT_ROLE_LABELS[agentId];
  if (direct) return direct;
  // Strip common suffixes and humanize (e.g. `qa_tester_v2` → `Qa Tester V2`).
  return agentId
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function truncateLabel(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

function formatFallbackLabel(name: string): string {
  console.warn(`[ToolLabels] Unknown tool name: "${name}"`);
  let cleanName = name.replace(/^[^:]+:/, '');
  cleanName = cleanName.replace(/^(august__?|workbench_)/, '');
  cleanName = cleanName.replace(/[_-]+/g, ' ');
  if (!cleanName.trim()) return 'Executing Tool';
  return cleanName
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Dynamic label resolver — handles tools that need context-aware labels.
 */
export function getToolLabel(
  toolName: string,
  context?: { agentId?: string; filename?: string; command?: string; status?: string }
): string {
  const clean = toolName.replace(/^[^:]+:/, '').replace(/^@/, '');
  const isRunning = context?.status === 'running';
  
  // Sub-agent: show the agent role if available
  if (
    clean === 'august__spawn_subagent' ||
    clean === 'workbench_spawn_subagent' ||
    clean === 'august_spawn_subagent' ||
    clean === 'invoke_subagent'
  ) {
    if (context?.agentId) {
      const roleLabel = AGENT_ROLE_LABELS[context.agentId] || context.agentId;
      return `Subagent • ${roleLabel}`;
    }
    return 'Subagent';
  }
  
  // Run command: show the actual command when available
  if (
    clean === 'august__run_command' ||
    clean === 'run_command' ||
    clean === 'august__bash' ||
    clean === 'august_bash'
  ) {
    const verb = isRunning ? 'Executing' : 'Executed';
    if (context?.command) {
      return `${verb} command: ${truncateLabel(context.command, 120)}`;
    }
    return `${verb} command`;
  }
  
  // File ops: show filename when available
  if (context?.filename) {
    const base = TOOL_LABEL_MAP[clean];
    if (base) return base; // filename is shown via FileIcon, don't duplicate
  }
  
  return TOOL_LABEL_MAP[clean] || formatFallbackLabel(toolName);
}

