/**
 * Maps raw tool names to user-friendly display labels.
 *
 * Keys are canonical tool names (no august__/workbench_ branding).
 * Incoming names are normalized via `normalizeToolName` before lookup.
 *
 * Status-aware:
 *   - 'running' → present continuous ("Searching", "Reading")
 *   - 'done'    → past simple        ("Searched", "Read")
 *   - 'error'   → past simple + "FAILED" pill handled at render site
 */

import { isSubagentToolName, normalizeToolName } from '@/lib/tool-classify';

const TOOL_LABEL_MAP: Record<string, string> = {
  // File operations
  read_file: 'Reading',
  read: 'Reading',
  view_file: 'Reading',

  write_file: 'Writing',
  write: 'Writing',
  write_to_file: 'Writing',

  edit_file: 'Editing',
  edit: 'Editing',
  replace_file_content: 'Editing',
  multi_replace_file_content: 'Editing',

  replace_text: 'Replacing',
  create_file: 'Creating',

  delete: 'Deleting',
  delete_file: 'Deleting',

  // Search & explore
  search: 'Searching',
  grep: 'Searching files',
  grep_search: 'Searching',
  web_search: 'Searching',
  search_web: 'Searching',
  web_fetch: 'Fetching',
  list_dir: 'Listing',
  list_directory: 'Listing',
  search_files: 'Searching files',

  // Commands
  run_command: 'Running',
  bash: 'Running',

  // Sub-agents & delegation (getToolLabel overrides spawn verbs)
  spawn_subagent: 'Subagent',
  spawn_subagents: 'Subagent',
  invoke_subagent: 'Subagent',
  delegate_task: 'Delegating',
  run_team: 'Running team',

  // Memory & knowledge
  remember: 'Saving memory',
  forget: 'Forgetting',
  recall: 'Recalling',
  memory_write: 'Saving memory',
  context_read: 'Reading context',
  memory_search: 'Searching memory',

  // Web & API
  web: 'Fetching',
  api: 'Calling API',
  read_url_content: 'Fetching',
  execute_url: 'Fetching',

  // System / environment / diagnostics
  system_info: 'Reading system info',
  describe_environment: 'Describing environment',
  diagnose_proxy: 'Diagnosing proxy',
  list_proxy_capabilities: 'Listing capabilities',

  // Agent registry / jobs
  list_agent_registry: 'Listing agents',
  list_agent_jobs: 'Listing jobs',
  get_agent_job: 'Fetching job',
  get_activity: 'Reading activity',

  // Planning
  submit_plan: 'Submitting plan',
  update_todos: 'Updating todos',

  // Skills
  load_skill: 'Loading skill',
  learn_subagent: 'Learning patterns',
  list_skills: 'Listing skills',
  skill_manage: 'Managing skill',

  // Self-config tools
  create_alias: 'Creating alias',
  update_alias: 'Updating alias',
  delete_alias: 'Deleting alias',
  list_aliases: 'Listing aliases',
  configure_fallback: 'Configuring fallback',
  get_fallback: 'Reading fallback config',
  create_agent: 'Creating agent',
  update_agent: 'Updating agent',
  delete_agent: 'Deleting agent',
  list_agents: 'Listing agents',

  // Brain / knowledge
  brain_query: 'Querying brain',
  fact_search: 'Searching facts',
  update_heuristics: 'Updating heuristics',
  update_state: 'Updating state',
  write_scratchpad: 'Writing scratchpad',

  // Blackboard
  write_blackboard: 'Writing blackboard',
  read_blackboard: 'Reading blackboard',
  clear_blackboard: 'Clearing blackboard',

  // Daemons
  spawn_daemon: 'Spawning daemon',
  list_daemons: 'Listing daemons',
  kill_daemon: 'Killing daemon',
};

/**
 * Past-simple / done-form verb map. Keys are canonical (no branding prefixes).
 * Missing entries fall back to -ing → -ed derivation.
 */
const TOOL_VERB_DONE: Record<string, string> = {
  read_file: 'Read',
  read: 'Read',
  view_file: 'Read',

  write_file: 'Wrote',
  write: 'Wrote',
  write_to_file: 'Wrote',

  edit_file: 'Edited',
  edit: 'Edited',
  replace_file_content: 'Edited',
  multi_replace_file_content: 'Edited',

  replace_text: 'Replaced',
  create_file: 'Created',

  delete: 'Deleted',
  delete_file: 'Deleted',

  search: 'Searched',
  grep: 'Searched files',
  grep_search: 'Searched',
  web_search: 'Searched',
  search_web: 'Searched',
  web_fetch: 'Fetched',
  list_dir: 'Listed',
  list_directory: 'Listed',
  search_files: 'Searched files',

  run_command: 'Ran',
  bash: 'Ran',

  spawn_subagent: 'Delegated',
  spawn_subagents: 'Delegated',
  invoke_subagent: 'Delegated',
  delegate_task: 'Delegated',
  run_team: 'Ran team',

  remember: 'Saved memory',
  forget: 'Forgot',
  recall: 'Recalled',
  memory_write: 'Saved memory',
  context_read: 'Read context',
  memory_search: 'Searched memory',

  web: 'Fetched',
  api: 'Called API',
  read_url_content: 'Fetched',
  execute_url: 'Fetched',

  system_info: 'Read system info',
  describe_environment: 'Described environment',
  diagnose_proxy: 'Diagnosed proxy',
  list_proxy_capabilities: 'Listed capabilities',

  list_agent_registry: 'Listed agents',
  list_agent_jobs: 'Listed jobs',
  get_agent_job: 'Fetched job',
  get_activity: 'Read activity',

  submit_plan: 'Submitted plan',
  update_todos: 'Updated todos',

  load_skill: 'Loaded skill',
  learn_subagent: 'Learned patterns',
  list_skills: 'Listed skills',
  skill_manage: 'Managed skill',

  create_alias: 'Created alias',
  update_alias: 'Updated alias',
  delete_alias: 'Deleted alias',
  list_aliases: 'Listed aliases',
  configure_fallback: 'Configured fallback',
  get_fallback: 'Read fallback config',
  create_agent: 'Created agent',
  update_agent: 'Updated agent',
  delete_agent: 'Deleted agent',
  list_agents: 'Listed agents',

  brain_query: 'Queried brain',
  fact_search: 'Searched facts',
  update_heuristics: 'Updated heuristics',
  update_state: 'Updated state',
  write_scratchpad: 'Wrote scratchpad',

  write_blackboard: 'Wrote blackboard',
  read_blackboard: 'Read blackboard',
  clear_blackboard: 'Cleared blackboard',

  spawn_daemon: 'Spawned daemon',
  list_daemons: 'Listed daemons',
  kill_daemon: 'Killed daemon',
};

const AGENT_ROLE_LABELS: Record<string, string> = {
  explore: 'Explore',
  plan: 'Plan',
  build: 'Build',
  general: 'General',
  coordinator: 'Coordinator',
  projectManager: 'Project Manager',
  frontendDev: 'Frontend',
  backendDev: 'Backend',
  qaTester: 'QA',
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
  return agentId
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function truncateLabel(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

function formatFallbackLabel(name: string): string {
  console.warn(`[ToolLabels] Unknown tool name: "${name}"`);
  const cleanName = normalizeToolName(name).replace(/[_-]+/g, ' ');
  if (!cleanName.trim()) return 'Executing Tool';
  return cleanName
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** Convert a present-continuous verb to past simple when no explicit
 *  done-form is mapped. Handles regular -ing endings and the
 *  "ying → yed" irregular case (Searching → Searched). */
function derivePastTense(running: string): string {
  if (running.endsWith('ying')) {
    return running.slice(0, -4) + 'yed';
  }
  if (running.endsWith('ing')) {
    const stem = running.slice(0, -3);
    if (stem.endsWith('e')) return stem + 'd';
    if (stem.length === 0) return running;
    return stem + 'ed';
  }
  const parts = running.split(' ');
  if (parts.length > 1 && parts[0].endsWith('ing')) {
    parts[0] = derivePastTense(parts[0]);
    return parts.join(' ');
  }
  return running;
}

/**
 * Dynamic, status-aware label resolver.
 * - 'running' → present continuous (e.g. "Searching")
 * - 'done'    → past simple        (e.g. "Searched")
 * - 'error'   → past simple + caller renders FAILED pill
 */
export function getToolLabel(
  toolName: string,
  context?: { agentId?: string; filename?: string; command?: string; status?: 'running' | 'done' | 'error' },
): string {
  const clean = normalizeToolName(toolName);
  const status = context?.status ?? 'running';
  const isRunning = status === 'running';

  if (isSubagentToolName(toolName) && clean !== 'run_team') {
    const verb = isRunning ? 'Delegating' : 'Delegated';
    if (context?.agentId) {
      const roleLabel = AGENT_ROLE_LABELS[context.agentId] || context.agentId;
      return `${verb} • ${roleLabel}`;
    }
    return verb;
  }

  if (clean === 'run_team') {
    return isRunning ? 'Running team' : 'Ran team';
  }

  if (clean === 'run_command' || clean === 'bash') {
    const verb = isRunning ? 'Running' : 'Ran';
    if (context?.command) {
      return `${verb}: ${truncateLabel(context.command, 120)}`;
    }
    return verb;
  }

  // File/dir tools: always put the path on the label ("Read src/a.ts", "Listed backend/").
  if (context?.filename) {
    const base =
      (isRunning ? TOOL_LABEL_MAP[clean] : undefined) ??
      (!isRunning ? TOOL_VERB_DONE[clean] : undefined) ??
      TOOL_LABEL_MAP[clean] ??
      (isRunning ? formatFallbackLabel(toolName) : derivePastTense(formatFallbackLabel(toolName)));
    return `${base} ${truncateLabel(context.filename, 80)}`;
  }

  if (isRunning) {
    return TOOL_LABEL_MAP[clean] || formatFallbackLabel(toolName);
  }
  return TOOL_VERB_DONE[clean] || derivePastTense(TOOL_LABEL_MAP[clean] || formatFallbackLabel(toolName));
}
