/**
 * Maps raw tool names to user-friendly display labels.
 *
 * Phase 3.Y: the labels are now status-aware — `getToolLabel` accepts a
 * `status` argument and returns a verb form that changes with state:
 *   - 'running' → present continuous ("Searching", "Reading")
 *   - 'done'    → past simple        ("Searched", "Read")
 *   - 'error'   → past simple + "FAILED" pill handled at render site
 *
 * The TOOL_LABEL_MAP below stores the running form; TOOL_VERB_DONE
 * stores the matching past tense.
 */

const TOOL_LABEL_MAP: Record<string, string> = {
  // File operations (running verbs)
  'august__read_file': 'Reading',
  'read_file': 'Reading',
  'august_read': 'Reading',
  'august__read': 'Reading',
  'view_file': 'Reading',

  'august__write_file': 'Writing',
  'write_file': 'Writing',
  'august_write': 'Writing',
  'august__write': 'Writing',
  'write_to_file': 'Writing',

  'august__edit_file': 'Editing',
  'edit_file': 'Editing',
  'august_edit': 'Editing',
  'august__edit': 'Editing',
  'replace_file_content': 'Editing',
  'multi_replace_file_content': 'Editing',

  'august__replace_text': 'Replacing',
  'replace_text': 'Replacing',
  'august__create_file': 'Creating',
  'create_file': 'Creating',

  'august_delete': 'Deleting',
  'august__delete': 'Deleting',
  'delete_file': 'Deleting',

  // Search & explore
  'august_search': 'Searching',
  'august__search': 'Searching',
  'august__grep': 'Searching files',
  'august__web_search': 'Searching',
  'web_search': 'Searching',
  'august__web_fetch': 'Fetching',
  'web_fetch': 'Fetching',
  'august__list_dir': 'Listing',
  'list_dir': 'Listing',
  'august__list_directory': 'Listing',
  'list_directory': 'Listing',
  'august__search_files': 'Searching files',
  'search_files': 'Searching files',
  'grep_search': 'Searching',
  'search_web': 'Searching',

  // Commands
  'august__run_command': 'Running',
  'run_command': 'Running',
  'august__bash': 'Running',
  'august_bash': 'Running',

  // Sub-agents & delegation
  'august__spawn_subagent': 'Subagent',
  'august_spawn_subagent': 'Subagent',
  'workbench_spawn_subagent': 'Subagent',
  'august__delegate_task': 'Delegating',
  'august__run_team': 'Running team',
  'workbench_run_team': 'Running team',

  // Memory & knowledge
  'august__remember': 'Saving memory',
  'august__forget': 'Forgetting',
  'august__recall': 'Recalling',
  'august_memory_write': 'Saving memory',
  'august__memory_write': 'Saving memory',

  // Web & API
  'august_web': 'Fetching',
  'august__web': 'Fetching',
  'august_api': 'Calling API',
  'august__api': 'Calling API',
  'read_url_content': 'Fetching',
  'execute_url': 'Fetching',

  // System / environment / diagnostics
  'august__system_info': 'Reading system info',
  'workbench_system_info': 'Reading system info',
  'august__describe_environment': 'Describing environment',
  'workbench_describe_environment': 'Describing environment',
  'august__diagnose_proxy': 'Diagnosing proxy',
  'workbench_diagnose_proxy': 'Diagnosing proxy',
  'august__list_proxy_capabilities': 'Listing capabilities',
  'workbench_list_proxy_capabilities': 'Listing capabilities',

  // Agent registry / jobs
  'august__list_agent_registry': 'Listing agents',
  'workbench_list_agent_registry': 'Listing agents',
  'august__list_agent_jobs': 'Listing jobs',
  'workbench_list_agent_jobs': 'Listing jobs',
  'august__get_agent_job': 'Fetching job',
  'workbench_get_agent_job': 'Fetching job',
  'august__get_activity': 'Reading activity',
  'workbench_get_activity': 'Reading activity',

  // Planning
  'august__submit_plan': 'Submitting plan',
  'august__update_todos': 'Updating todos',

  // Skills
  'august__load_skill': 'Loading skill',
  'august__learn_subagent': 'Learning patterns',
};

/**
 * Past-simple / done-form verb map. Keys mirror TOOL_LABEL_MAP; missing
 * entries fall back to the simple "remove trailing -ing → +ed" derivation
 * (or "ying" → "yed" for words like "Searching" → "Searched").
 */
const TOOL_VERB_DONE: Record<string, string> = {
  // File ops
  'august__read_file': 'Read',
  'read_file': 'Read',
  'august_read': 'Read',
  'august__read': 'Read',
  'view_file': 'Read',

  'august__write_file': 'Wrote',
  'write_file': 'Wrote',
  'august_write': 'Wrote',
  'august__write': 'Wrote',
  'write_to_file': 'Wrote',

  'august__edit_file': 'Edited',
  'edit_file': 'Edited',
  'august_edit': 'Edited',
  'august__edit': 'Edited',
  'replace_file_content': 'Edited',
  'multi_replace_file_content': 'Edited',

  'august__replace_text': 'Replaced',
  'replace_text': 'Replaced',
  'august__create_file': 'Created',
  'create_file': 'Created',

  'august_delete': 'Deleted',
  'august__delete': 'Deleted',
  'delete_file': 'Deleted',

  // Search & explore
  'august_search': 'Searched',
  'august__search': 'Searched',
  'august__grep': 'Searched files',
  'august__web_search': 'Searched',
  'web_search': 'Searched',
  'august__web_fetch': 'Fetched',
  'web_fetch': 'Fetched',
  'august__list_dir': 'Listed',
  'list_dir': 'Listed',
  'august__list_directory': 'Listed',
  'list_directory': 'Listed',
  'august__search_files': 'Searched files',
  'search_files': 'Searched files',
  'grep_search': 'Searched',
  'search_web': 'Searched',

  // Commands
  'august__run_command': 'Ran',
  'run_command': 'Ran',
  'august__bash': 'Ran',
  'august_bash': 'Ran',

  // Sub-agents & delegation
  'august__spawn_subagent': 'Delegated',
  'august_spawn_subagent': 'Delegated',
  'workbench_spawn_subagent': 'Delegated',
  'august__delegate_task': 'Delegated',
  'august__run_team': 'Ran team',
  'workbench_run_team': 'Ran team',

  // Memory & knowledge
  'august__remember': 'Saved memory',
  'august__forget': 'Forgot',
  'august__recall': 'Recalled',
  'august_memory_write': 'Saved memory',
  'august__memory_write': 'Saved memory',

  // Web & API
  'august_web': 'Fetched',
  'august__web': 'Fetched',
  'august_api': 'Called API',
  'august__api': 'Called API',
  'read_url_content': 'Fetched',
  'execute_url': 'Fetched',

  // System / environment / diagnostics
  'august__system_info': 'Read system info',
  'workbench_system_info': 'Read system info',
  'august__describe_environment': 'Described environment',
  'workbench_describe_environment': 'Described environment',
  'august__diagnose_proxy': 'Diagnosed proxy',
  'workbench_diagnose_proxy': 'Diagnosed proxy',
  'august__list_proxy_capabilities': 'Listed capabilities',
  'workbench_list_proxy_capabilities': 'Listed capabilities',

  // Agent registry / jobs
  'august__list_agent_registry': 'Listed agents',
  'workbench_list_agent_registry': 'Listed agents',
  'august__list_agent_jobs': 'Listed jobs',
  'workbench_list_agent_jobs': 'Listed jobs',
  'august__get_agent_job': 'Fetched job',
  'workbench_get_agent_job': 'Fetched job',
  'august__get_activity': 'Read activity',
  'workbench_get_activity': 'Read activity',

  // Planning
  'august__submit_plan': 'Submitted plan',
  'august__update_todos': 'Updated todos',

  // Skills
  'august__load_skill': 'Loaded skill',
  'august__learn_subagent': 'Learned patterns',
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

/** Convert a present-continuous verb to past simple when no explicit
 *  done-form is mapped. Handles regular -ing endings and the
 *  "ying → yed" irregular case (Searching → Searched). */
function derivePastTense(running: string): string {
  if (running.endsWith('ying')) {
    return running.slice(0, -4) + 'yed';
  }
  if (running.endsWith('ing')) {
    // Drop trailing 'e' before adding 'ed' if present ("Creating" → "Created")
    const stem = running.slice(0, -3);
    if (stem.endsWith('e')) return stem + 'd';
    if (stem.length === 0) return running;
    return stem + 'ed';
  }
  // Multi-word like "Searching files" → process first word
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
 *
 * Special handling for sub-agent (role label) and run_command (command
 * string appended) is preserved from the prior version.
 */
export function getToolLabel(
  toolName: string,
  context?: { agentId?: string; filename?: string; command?: string; status?: 'running' | 'done' | 'error' }
): string {
  const clean = toolName.replace(/^[^:]+:/, '').replace(/^@/, '');
  const status = context?.status ?? 'running';
  const isRunning = status === 'running';

  // Sub-agent: show the agent role if available
  if (
    clean === 'august__spawn_subagent' ||
    clean === 'workbench_spawn_subagent' ||
    clean === 'august_spawn_subagent' ||
    clean === 'invoke_subagent'
  ) {
    const verb = isRunning ? 'Delegating' : 'Delegated';
    if (context?.agentId) {
      const roleLabel = AGENT_ROLE_LABELS[context.agentId] || context.agentId;
      return `${verb} • ${roleLabel}`;
    }
    return isRunning ? 'Delegating' : 'Delegated';
  }

  // Run command: show the actual command when available
  if (
    clean === 'august__run_command' ||
    clean === 'run_command' ||
    clean === 'august__bash' ||
    clean === 'august_bash'
  ) {
    const verb = isRunning ? 'Running' : 'Ran';
    if (context?.command) {
      return `${verb}: ${truncateLabel(context.command, 120)}`;
    }
    return verb;
  }

  // Filename-aware tools (file ops): append filename as a suffix
  // when context provides one. Verbs come from the maps above.
  if (context?.filename) {
    const base =
      (isRunning ? TOOL_LABEL_MAP[clean] : undefined) ??
      (!isRunning ? TOOL_VERB_DONE[clean] : undefined) ??
      TOOL_LABEL_MAP[clean];
    if (base) return base;
  }

  // Plain verb lookup
  if (isRunning) {
    return TOOL_LABEL_MAP[clean] || formatFallbackLabel(toolName);
  }
  return TOOL_VERB_DONE[clean] || derivePastTense(TOOL_LABEL_MAP[clean] || formatFallbackLabel(toolName));
}
