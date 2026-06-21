/**
 * Maps raw tool names to user-friendly display labels.
 * For dynamic labels (e.g. subagent), a function takes the tool context
 * and returns the label.
 */

const TOOL_LABEL_MAP: Record<string, string> = {
  // File operations
  'august__read_file': 'Reading file',
  'read_file': 'Reading file',
  'august__write_file': 'Writing file',
  'write_file': 'Writing file',
  'august__edit_file': 'Editing file',
  'edit_file': 'Editing file',
  'august__replace_text': 'Replacing text',
  'replace_text': 'Replacing text',
  'august__create_file': 'Creating file',
  'create_file': 'Creating file',
  
  // Search & explore
  'august__search': 'Searching',
  'august__grep': 'Searching files',
  'august__web_search': 'Searching the web',
  'web_search': 'Searching the web',
  'august__web_fetch': 'Fetching page',
  'web_fetch': 'Fetching page',
  'august__list_dir': 'Listing directory',
  'list_dir': 'Listing directory',
  'august__list_directory': 'Listing directory',
  'list_directory': 'Listing directory',
  'august__search_files': 'Searching files',
  'search_files': 'Searching files',
  
  // Commands
  'august__run_command': 'Running command',
  'run_command': 'Running command',
  'august__bash': 'Running command',
  
  // Sub-agents & delegation
  'august__spawn_subagent': 'Spawning sub-agent',
  'workbench_spawn_subagent': 'Spawning sub-agent',
  'august__delegate_task': 'Delegating task',
  'august__run_team': 'Running team',
  'workbench_run_team': 'Running team',
  
  // Memory & knowledge
  'august__remember': 'Saving to memory',
  'august__forget': 'Removing from memory',
  'august__recall': 'Recalling memory',
  
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

function truncateLabel(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

function formatFallbackLabel(name: string): string {
  // Strip common prefixes, replace underscores, title-case
  const stripped = name
    .replace(/^august__/, '')
    .replace(/^workbench_/, '')
    .replace(/_/g, ' ');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * Dynamic label resolver — handles tools that need context-aware labels.
 */
export function getToolLabel(
  toolName: string,
  context?: { agentId?: string; filename?: string; command?: string }
): string {
  const clean = toolName.replace(/^@/, '');
  
  // Sub-agent: show the agent role if available
  if (clean === 'august__spawn_subagent' || clean === 'workbench_spawn_subagent') {
    if (context?.agentId) {
      const roleLabel = AGENT_ROLE_LABELS[context.agentId] || context.agentId;
      return `Sub-agent · ${roleLabel}`;
    }
    return 'Spawning sub-agent';
  }
  
  // Run command: show the actual command when available
  if (clean === 'august__run_command' || clean === 'run_command' || clean === 'august__bash') {
    if (context?.command) {
      return `Executed: ${truncateLabel(context.command, 120)}`;
    }
    return 'Running command';
  }
  
  // File ops: show filename when available
  if (context?.filename) {
    const base = TOOL_LABEL_MAP[clean];
    if (base) return base; // filename is shown via FileIcon, don't duplicate
  }
  
  return TOOL_LABEL_MAP[clean] || formatFallbackLabel(clean);
}
