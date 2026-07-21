/**
 * tool-context-format — turn the JSON-encoded tool context / result that the
 * workbench streams into a human-readable line for the chat thread UI.
 *
 * The workbench stores tool input args as a JSON string on `tool.context`,
 * and tool results as JSON on `tool.summary` for some tools (web_search,
 * list_directory, …). Displaying the raw object in the chat thread is
 * machine-readable but user-hostile — this helper produces a one-line
 * summary plus the original raw payload so the UI can offer a "Show raw"
 * toggle.
 */

import { formatBytes, formatDuration } from './utils';
import { normalizeToolName } from './tool-classify';
import { pathBasename } from './tool-labels';

export interface FormattedContext {
  /** Human-readable summary, e.g. `Searched: "plan verification"`. */
  summary: string;
  /** Original raw text (JSON or otherwise) — render in a "Show raw" toggle. */
  raw: string;
  /**
   * Semantic classification so the UI can render an icon + colour.
   *   'success' — green check, e.g. `✅ Directory found. Top-level: …`
   *   'neutral' — default styling (default if omitted)
   */
  kind?: 'success' | 'neutral';
}

export interface FormattedError {
  /** Short, user-friendly error message, e.g. `Directory '…' does not exist.` */
  message: string;
  /** Optional extra detail (e.g. exit code, file path, line number). */
  detail?: string;
  /** Original raw error text — render in a "Show raw" toggle. */
  raw: string;
}

/** Strip branding prefixes so format tables match on canonical tool names. */
export function canonicalToolName(name: string): string {
  return normalizeToolName(name);
}

const FILE_OPS = new Set([
  'read_file',
  'read',
  'view_file',
  'write_file',
  'write',
  'write_to_file',
  'edit_file',
  'edit',
  'replace_file_content',
  'multi_replace_file_content',
  'replace_text',
  'create_file',
  'delete_file',
  'delete',
]);

const SEARCH_OPS = new Set([
  'grep_search',
  'grep',
  'search_files',
  'search',
  'august_search',
  'august__search',
]);

const WEB_OPS = new Set([
  'web_search',
  'web_fetch',
  'web',
  'search_web',
  'read_url_content',
  'execute_url',
]);

const MEMORY_OPS = new Set(['remember', 'forget', 'recall', 'memory_write']);

const SUBAGENT_OPS = new Set([
  'spawn_subagent',
  'spawn_subagents',
  'invoke_subagent',
  'delegate_task',
  'run_team',
]);

const LIST_OPS = new Set(['list_dir', 'list_directory', 'ls']);

const SYSTEM_OPS = new Set([
  'system_info',
  'describe_environment',
]);

const DIAGNOSTIC_OPS = new Set([
  'diagnose_proxy',
  'list_proxy_capabilities',
]);

const AGENT_LIST_OPS = new Set([
  'list_agent_registry',
  'list_agent_jobs',
]);

const AGENT_GET_OPS = new Set(['get_agent_job']);

const ACTIVITY_OPS = new Set(['get_activity']);

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

function tryParse(json?: string): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* not JSON — caller decides what to do */
  }
  return null;
}

/**
 * Format a tool's `context` (input args) as a human-readable line.
 * Returns null only if there is nothing to format.
 */
export function formatToolContext(toolName: string, contextJson?: string): FormattedContext | null {
  if (!contextJson) return null;
  const raw = contextJson;
  const canonical = canonicalToolName(toolName);

  // Try to parse as JSON; fall back to showing the raw text verbatim.
  const parsed = tryParse(raw);

  // File ops
  if (FILE_OPS.has(canonical)) {
    const path = parsed && pickString(parsed, ['filePath', 'file_path', 'path', 'filename', 'file', 'filepath', 'notebook_path', 'target_file']);
    if (path) {
      const verb =
        canonical.startsWith('write') || canonical === 'create_file' ? 'Writing' :
        canonical.startsWith('edit') || canonical.startsWith('replace') ? 'Editing' :
        canonical.startsWith('delete') ? 'Deleting' :
        'Reading';
      return { summary: `${verb} ${pathBasename(path)}`, raw };
    }
  }

  // List directory
  if (LIST_OPS.has(canonical)) {
    const path = parsed && pickString(parsed, ['path', 'dir', 'directory', 'filePath', 'file_path']);
    if (path) return { summary: `Listing directory ${pathBasename(path)}`, raw };
    return { summary: 'Listing directory', raw };
  }

  // Web search / fetch
  if (WEB_OPS.has(canonical)) {
    const query = parsed && pickString(parsed, ['query', 'q', 'url', 'searchQuery', 'search_query']);
    const maxResults = parsed && (typeof parsed.maxResults === 'number' ? parsed.maxResults : (typeof parsed.maxResults === 'number' ? parsed.maxResults : undefined));
    const verb = canonical === 'web_fetch' || canonical === 'web' || canonical === 'read_url_content' || canonical === 'execute_url'
      ? 'Fetching'
      : 'Searched';
    if (query) {
      const tail = typeof maxResults === 'number' ? ` · ${maxResults} results` : '';
      return { summary: `${verb}: "${query}"${tail}`, raw };
    }
    return { summary: verb === 'Fetching' ? 'Fetching URL' : 'Web request', raw };
  }

  // Grep / search files
  if (SEARCH_OPS.has(canonical)) {
    const pattern = parsed && pickString(parsed, ['pattern', 'query', 'q', 'regex', 'searchPattern', 'search_pattern']);
    const path = parsed && pickString(parsed, ['path', 'dir', 'directory', 'filePath', 'file_path', 'includePattern', 'include_pattern']);
    if (pattern && path) {
      return { summary: `Searching files: "${truncate(pattern, 80)}" in ${pathBasename(path)}`, raw };
    }
    if (pattern) return { summary: `Searching files: "${truncate(pattern, 80)}"`, raw };
    return { summary: 'Searching files', raw };
  }

  // Run command / bash
  if (canonical === 'run_command' || canonical === 'bash') {
    const cmd = parsed && pickString(parsed, ['command', 'cmd', 'shell_command', 'shellCommand', 'script']);
    if (cmd) return { summary: `Executing command: ${truncate(cmd, 120)}`, raw };
    return { summary: 'Executing command', raw };
  }

  // Memory ops
  if (MEMORY_OPS.has(canonical)) {
    return { summary: 'Updating memory', raw };
  }

  // Subagent / team spawn — show agent + task summary
  if (SUBAGENT_OPS.has(canonical)) {
    const agentId = parsed && pickString(parsed, ['agentId', 'agent', 'subagentType', 'team']);
    const task = parsed && pickString(parsed, ['task', 'prompt', 'description', 'goal']);
    if (agentId && task) {
      return { summary: `Spawning subagent ${agentId}: "${truncate(task, 100)}"`, raw };
    }
    if (agentId) {
      return { summary: `Spawning subagent ${agentId}`, raw };
    }
    if (task) {
      return { summary: `Spawning subagent: "${truncate(task, 100)}"`, raw };
    }
    return { summary: canonical === 'run_team' ? 'Running team' : 'Spawning subagent', raw };
  }

  // Loading skill
  if (canonical === 'load_skill') {
    const skill = parsed && pickString(parsed, ['skill', 'name', 'skill_name']);
    if (skill) return { summary: `Loading skill ${skill}`, raw };
    return { summary: 'Loading skill', raw };
  }

  // Generic fallback — humanize the canonical name and surface the first
  // scalar arg so the user has a hint of what's being invoked.
  if (parsed) {
    const human = canonical
      .replace(/[_-]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || 'Executing tool';
    const firstScalar = Object.values(parsed).find(v => typeof v === 'string' && v.length > 0) as string | undefined;
    if (firstScalar) {
      return { summary: `${human}: ${truncate(firstScalar, 100)}`, raw };
    }
    return { summary: human, raw };
  }

  // Not JSON — show the raw text as-is (it's already human-readable).
  return { summary: raw, raw };
}

/**
 * Lighter pass for the `result` field. Some tools emit JSON-shaped results
 * (e.g. `web_search` returns `{ results: [...] }`, `list_directory` returns
 * `{ entries: [...] }`). When we recognise the shape, render a friendly
 * summary that includes a preview of the actual contents (file names,
 * top search hits, etc.) rather than just a count. Otherwise return null so
 * the existing text rendering is preserved.
 */
export function formatToolResult(toolName: string, summaryText?: string): FormattedContext | null {
  if (!summaryText) return null;
  const raw = summaryText;
  const canonical = canonicalToolName(toolName);
  const parsed = tryParse(raw);
  if (!parsed) return null;

  // web_search / web_fetch → success with top-hit titles
  if (WEB_OPS.has(canonical)) {
    const results = Array.isArray(parsed.results) ? parsed.results
      : Array.isArray(parsed.hits) ? parsed.hits
      : null;
    if (results) {
      if (results.length === 0) {
        return { summary: 'No results found', raw, kind: 'success' };
      }
      const titles = results
        .map((r: unknown) => {
          if (typeof r === 'string') return r;
          if (r && typeof r === 'object') {
            const o = r as Record<string, unknown>;
            const t = pickString(o, ['title', 'name']);
            if (t) return t;
            const u = pickString(o, ['url', 'link']);
            if (u) return u;
          }
          return '';
        })
        .filter(Boolean)
        .slice(0, 3);
      const head = titles.length > 0 ? `: ${titles.join(' · ')}` : '';
      const more = results.length - titles.length;
      const tail = more > 0 ? ` (+${more} more)` : '';
      return {
        summary: `Found ${results.length} result${results.length === 1 ? '' : 's'}${head}${tail}`,
        raw,
        kind: 'success',
      };
    }
  }

  // list_directory → success with top-level names
  if (LIST_OPS.has(canonical)) {
    const entries = Array.isArray(parsed.entries) ? parsed.entries
      : Array.isArray(parsed.files) ? parsed.files
      : Array.isArray(parsed.items) ? parsed.items
      : null;
    if (entries) {
      if (entries.length === 0) {
        return { summary: 'Directory is empty', raw, kind: 'success' };
      }
      const names = entries
        .map((e: unknown): string => {
          if (typeof e === 'string') return e;
          if (e && typeof e === 'object') {
            const o = e as Record<string, unknown>;
            const n = pickString(o, ['name', 'path', 'filename', 'file', 'entry']);
            if (n) return n;
          }
          return '';
        })
        .filter(Boolean)
        .slice(0, 5);
      const more = entries.length - names.length;
      const head = names.length > 0 ? `: ${names.join(', ')}` : '';
      const tail = more > 0 ? ` (+${more} more)` : '';
      const verb = parsed.truncated ? 'Found at least ' : 'Found ';
      return {
        summary: `${verb}${entries.length} item${entries.length === 1 ? '' : 's'}${head}${tail}`,
        raw,
        kind: 'success',
      };
    }
  }

  // search_files / grep → success with match count
  if (SEARCH_OPS.has(canonical)) {
    const matches = Array.isArray(parsed.matches) ? parsed.matches
      : Array.isArray(parsed.results) ? parsed.results
      : Array.isArray(parsed.files) ? parsed.files
      : null;
    if (matches) {
      if (matches.length === 0) {
        return { summary: 'No matches found', raw, kind: 'success' };
      }
      return {
        summary: `${matches.length} match${matches.length === 1 ? '' : 'es'} found`,
        raw,
        kind: 'success',
      };
    }
  }

  // system_info / describe_environment → success with platform + memory + uptime
  if (SYSTEM_OPS.has(canonical)) {
    // Backend wraps the real payload in `{ ok, result }` for system_info,
    // and returns `{ generatedAt, environment: {...} }` for describe_environment.
    // Unwrap whichever shape is present.
    const sys = (parsed.result && typeof parsed.result === 'object' ? parsed.result : parsed) as Record<string, unknown>;
    if (canonical === 'system_info' && sys && typeof sys === 'object') {
      const platform = pickString(sys, ['platform']) ?? '?';
      const arch = pickString(sys, ['arch']);
      const cpus = Array.isArray(sys.cpus) ? sys.cpus.length : (typeof sys.cpus === 'number' ? sys.cpus : undefined);
      const totalMem = typeof sys.totalmem === 'number' ? sys.totalmem : undefined;
      const uptime = typeof sys.uptime === 'number' ? sys.uptime : undefined;
      const parts = [platform];
      if (arch) parts.push(arch);
      if (typeof cpus === 'number') parts.push(`${cpus} CPU${cpus === 1 ? '' : 's'}`);
      if (typeof totalMem === 'number') parts.push(formatBytes(totalMem));
      if (typeof uptime === 'number') parts.push(`up ${formatDuration(uptime * 1000)}`);
      return { summary: `System info: ${parts.join(' · ')}`, raw, kind: 'success' };
    }
    if (canonical === 'describe_environment' && sys && typeof sys === 'object') {
      const env = (sys.environment && typeof sys.environment === 'object' ? sys.environment : sys) as Record<string, unknown>;
      const envName = pickString(env, ['name', 'env', 'environment']) ?? 'environment';
      const version = pickString(env, ['version']);
      const head = version ? `${envName} ${version}` : envName;
      return { summary: `Environment: ${head}`, raw, kind: 'success' };
    }
  }

  // diagnose_proxy / list_proxy_capabilities
  if (DIAGNOSTIC_OPS.has(canonical)) {
    if (canonical === 'diagnose_proxy') {
      const status = pickString(parsed, ['status']) ?? 'unknown';
      const capsCount = Array.isArray(parsed.capabilities) ? parsed.capabilities.length : 0;
      const actCount = Array.isArray(parsed.activity) ? parsed.activity.length : 0;
      const actionsCount = Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions.length : 0;
      if (status === 'ok') {
        return {
          summary: `Diagnostics: ok · ${capsCount} capabilities · ${actCount} recent events`,
          raw,
          kind: 'success',
        };
      }
      return {
        summary: `Diagnostics: ${status} · ${actionsCount} action${actionsCount === 1 ? '' : 's'} recommended`,
        raw,
        kind: 'neutral',
      };
    }
    if (canonical === 'list_proxy_capabilities') {
      const caps = Array.isArray(parsed.capabilities) ? parsed.capabilities
        : Array.isArray(parsed) ? parsed
        : null;
      if (caps) {
        const names = caps
          .map((c: unknown): string => {
            if (typeof c === 'string') return c;
            if (c && typeof c === 'object') {
              const o = c as Record<string, unknown>;
              return pickString(o, ['name', 'id', 'tool']) ?? '';
            }
            return '';
          })
          .filter(Boolean)
          .slice(0, 3);
        const more = caps.length - names.length;
        const head = names.length > 0 ? `: ${names.join(', ')}` : '';
        const tail = more > 0 ? ` (+${more} more)` : '';
        return {
          summary: `${caps.length} capabilit${caps.length === 1 ? 'y' : 'ies'}${head}${tail}`,
          raw,
          kind: 'success',
        };
      }
    }
  }

  // list_agent_registry / list_agent_jobs
  if (AGENT_LIST_OPS.has(canonical)) {
    if (canonical === 'list_agent_registry') {
      const agents = Array.isArray(parsed.agents) ? parsed.agents : null;
      if (agents) {
        const roles = agents
          .map((a: unknown): string => {
            if (a && typeof a === 'object') {
              const o = a as Record<string, unknown>;
              return pickString(o, ['role', 'type', 'name']) ?? '';
            }
            return '';
          })
          .filter(Boolean);
        const uniqueRoles = Array.from(new Set(roles)).slice(0, 3);
        const roleSummary = uniqueRoles.length > 0 ? ` (${uniqueRoles.join(', ')})` : '';
        const more = agents.length - uniqueRoles.length;
        const tail = more > 0 ? ` +${more} more` : '';
        return {
          summary: `${agents.length} agent${agents.length === 1 ? '' : 's'} registered${roleSummary}${tail}`,
          raw,
          kind: 'success',
        };
      }
    }
    if (canonical === 'list_agent_jobs') {
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : null;
      if (jobs) {
        const counts: Record<string, number> = {};
        for (const j of jobs) {
          if (j && typeof j === 'object') {
            const status = pickString(j as Record<string, unknown>, ['status']) ?? 'unknown';
            counts[status] = (counts[status] ?? 0) + 1;
          }
        }
        const parts = Object.entries(counts).map(([s, n]) => `${n} ${s}`);
        const head = parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
        return {
          summary: `${jobs.length} job${jobs.length === 1 ? '' : 's'}${head}`,
          raw,
          kind: 'success',
        };
      }
    }
  }

  // get_agent_job
  if (AGENT_GET_OPS.has(canonical)) {
    const id = pickString(parsed, ['id', 'job_id', 'jobId']);
    const status = pickString(parsed, ['status']) ?? 'unknown';
    const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined;
    const completedAt = typeof parsed.completedAt === 'number' ? parsed.completedAt : undefined;
    const duration =
      typeof startedAt === 'number' && typeof completedAt === 'number'
        ? formatDuration(completedAt - startedAt)
        : undefined;
    const idStr = id ? id.slice(0, 8) : '?';
    const durStr = duration ? ` · ${duration}` : '';
    return {
      summary: `Job ${idStr} · ${status}${durStr}`,
      raw,
      kind: status === 'completed' || status === 'done' || status === 'ok' ? 'success' : 'neutral',
    };
  }

  // get_activity
  if (ACTIVITY_OPS.has(canonical)) {
    const events = Array.isArray(parsed.events) ? parsed.events
      : Array.isArray(parsed.activity) ? parsed.activity
      : null;
    if (events) {
      if (events.length === 0) {
        return { summary: 'No recent activity', raw, kind: 'success' };
      }
      const first = events[0];
      let firstSummary = '';
      if (typeof first === 'string') firstSummary = first;
      else if (first && typeof first === 'object') {
        const o = first as Record<string, unknown>;
        firstSummary =
          pickString(o, ['message', 'summary', 'event', 'description']) ??
          pickString(o, ['type', 'kind', 'action']) ??
          '';
      }
      const tail = firstSummary ? `: "${truncate(firstSummary, 80)}"` : '';
      return {
        summary: `${events.length} recent event${events.length === 1 ? '' : 's'}${tail}`,
        raw,
        kind: 'success',
      };
    }
  }

  // Generic `status: ok` payload (common in workbench responses)
  const status = pickString(parsed, ['status']);
  if (status === 'ok' || status === 'success') {
    const message = pickString(parsed, ['message', 'detail']);
    if (message) {
      return { summary: message, raw, kind: 'success' };
    }
    return { summary: 'Completed successfully', raw, kind: 'success' };
  }

  return null;
}

/**
 * Parse a tool's error string into a structured `FormattedError` so the UI
 * can render a prominent ❌ block instead of dumping raw JSON.
 *
 * Handles three shapes:
 *   1. Plain-text error string (most common) — trimmed and returned as-is.
 *   2. JSON object with a `message`/`error`/`reason` field — that field is
 *      surfaced as `message`, optional `code`/`exit_code` as `detail`.
 *   3. JSON object without a recognisable message — fall back to a generic
 *      "Tool failed" message with the raw text in the toggle.
 */
export function formatToolError(toolName: string, errorText?: string): FormattedError | null {
  if (!errorText) return null;
  const raw = errorText;
  const parsed = tryParse(raw);

  if (parsed) {
    const message = pickString(parsed, ['message', 'error', 'detail', 'reason', 'description', 'msg']);
    const detailParts: string[] = [];
    const code = pickString(parsed, ['code', 'error_code']);
    const exitCode = typeof parsed.exit_code === 'number'
      ? String(parsed.exit_code)
      : typeof parsed.exitCode === 'number'
        ? String(parsed.exitCode)
        : undefined;
    const path = pickString(parsed, ['path', 'filePath', 'file_path', 'file', 'directory']);
    if (code) detailParts.push(`code: ${code}`);
    if (exitCode) detailParts.push(`exit: ${exitCode}`);
    if (path) detailParts.push(path);
    if (message) {
      return { message, detail: detailParts.length ? detailParts.join(' · ') : undefined, raw };
    }
    // JSON-shaped error without a recognisable message — still parsed, but
    // surface a generic message and let the user expand for the raw shape.
    return { message: `${canonicalToolName(toolName) || 'Tool'} failed`, raw };
  }

  // Plain-text error — clean up trailing whitespace/newlines.
  const cleaned = raw.trim();
  if (!cleaned) return null;
  return { message: cleaned, raw };
}