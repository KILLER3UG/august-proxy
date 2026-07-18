/**
 * Classify tool names into activity buckets for the chat ToolSummary header.
 *
 * Buckets:
 *   view  — reads, greps, lists, web fetch/search
 *   edit  — writes, patches, deletes, creates
 *   run   — shell / terminal commands
 *   tool  — everything else (subagents, memory, config, …)
 */

export type ToolBucket = 'view' | 'edit' | 'run' | 'tool';

/** Strip workbench / august / @ / namespace prefixes for matching. */
export function normalizeToolName(name: string): string {
  return (name || '')
    .replace(/^[^:]+:/, '')
    .replace(/^@+/, '')
    .replace(/^(august__?|workbench_)/i, '')
    .toLowerCase();
}

/** Canonical subagent / team spawn names (after normalizeToolName). */
const SUBAGENT_CANONICAL = new Set([
  'spawn_subagent',
  'spawn_subagents',
  'invoke_subagent',
  'delegate_task',
  'run_team',
]);

/** True for any prefixed/bare spawn or team tool name. */
export function isSubagentToolName(name?: string): boolean {
  if (!name) return false;
  return SUBAGENT_CANONICAL.has(normalizeToolName(name));
}

const VIEW_NAMES = new Set([
  'read_file',
  'read',
  'view_file',
  'grep',
  'grep_search',
  'search',
  'search_files',
  'list_dir',
  'list_files',
  'list_directory',
  'list_dir_tree',
  'memory_search',
  'context_read',
  'web_search',
  'web_fetch',
  'web',
  'search_web',
  'read_url_content',
  'execute_url',
  'read_blackboard',
  'fact_search',
  'brain_query',
  'get_activity',
  'get_agent_job',
  'list_agent_jobs',
  'list_agent_registry',
  'list_proxy_capabilities',
  'list_skills',
  'list_aliases',
  'list_agents',
  'list_daemons',
  'system_info',
  'describe_environment',
  'get_fallback',
  'recall',
]);

const EDIT_NAMES = new Set([
  'write_file',
  'write',
  'write_to_file',
  'edit_file',
  'edit',
  'replace_file',
  'replace_file_content',
  'multi_replace_file_content',
  'apply_patch',
  'create_file',
  'str_replace',
  'replace_text',
  'delete_file',
  'delete',
  'write_scratchpad',
  'write_blackboard',
  'clear_blackboard',
  'update_todos',
  'update_heuristics',
  'update_state',
]);

const RUN_NAMES = new Set([
  'bash',
  'run_command',
  'terminal',
  'exec',
  'shell',
  'shell_command',
  'powershell',
  'cmd',
]);

/**
 * Map a raw tool name (with or without august__/workbench_/@ prefix) to a
 * summary bucket used by the collapsed activity header.
 */
export function classifyTool(name: string): ToolBucket {
  const n = normalizeToolName(name);
  if (!n) return 'tool';

  if (RUN_NAMES.has(n) || n.includes('run_command') || n === 'bash' || n.endsWith('_bash')) {
    return 'run';
  }
  if (n.includes('bash') || n.includes('shell') || n.includes('terminal')) {
    return 'run';
  }

  if (EDIT_NAMES.has(n)) return 'edit';
  if (
    n.startsWith('write_file') ||
    n.startsWith('edit_file') ||
    n.startsWith('create_file') ||
    n.startsWith('delete_file') ||
    n.includes('replace_file') ||
    n.includes('str_replace') ||
    n.includes('apply_patch') ||
    (n.includes('replace') && n.includes('file')) ||
    n.includes('patch')
  ) {
    return 'edit';
  }

  if (VIEW_NAMES.has(n)) return 'view';
  if (
    n.startsWith('read_') ||
    n.startsWith('list_') ||
    n.startsWith('search_') ||
    n.startsWith('view_') ||
    n.includes('grep') ||
    n.includes('web_fetch') ||
    n.includes('web_search')
  ) {
    return 'view';
  }

  return 'tool';
}
