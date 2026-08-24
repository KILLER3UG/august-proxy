/**
 * Extract a filename hint from a tool's JSON context (best-effort).
 * Returns null if the context isn't JSON or no filename-shaped key is present.
 */
export function extractFilename(context?: string): string | null {
  if (!context) return null;
  try {
    const parsed = JSON.parse(context);
    if (typeof parsed === 'string') return parsed;
    for (const key of [
      'filePath',
      'file_path',
      'path',
      'filename',
      'file',
      'filepath',
      'notebook_path',
      'target_file',
      'dir',
      'directory',
      'target_directory',
    ]) {
      const v = parsed[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    /* not JSON — ignore */
  }
  return null;
}

/**
 * Best-effort extraction of the actual command string for run_command tools.
 * The workbench stores tool input as a JSON-encoded `context` string, so
 * we look for an obvious `command` (or `cmd` / `shell_command`) field.
 */
export function extractCommand(context?: string): string | null {
  if (!context) return null;
  try {
    const parsed = JSON.parse(context);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      for (const key of ['command', 'cmd', 'shell_command', 'shellCommand', 'script']) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
  } catch {
    /* not JSON — ignore */
  }
  return null;
}

/**
 * Best-effort extraction of the agentId parameter from a tool's context.
 */
export function extractAgentId(context?: string): string | null {
  if (!context) return null;
  try {
    const parsed = JSON.parse(context);
    if (parsed && typeof parsed === 'object') {
      for (const key of ['agentId', 'agent', 'subagentType']) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
  } catch {
    /* not JSON — ignore */
  }
  return null;
}

/**
 * Best-effort extraction of diff inputs from a tool's args / result.
 * Returns a payload compatible with <DiffView> props.
 */
export function extractDiffData(tool: { context?: string; result?: unknown; name?: string; inlineDiff?: string }): {
  diff?: string;
  oldContent?: string;
  newContent?: string;
} | null {
  const isEditLike = /^(write_file|edit_file|replace_file|apply_patch|create_file|str_replace|@write_file|@edit_file|@replace_file|@apply_patch|@create_file|@str_replace)/i.test(
    (tool.name || '').replace(/^@/, '')
  );
  if (!isEditLike) return null;

  // 1) Pre-formatted diff (most common — workbench already computes it)
  if (tool.context && typeof tool.context === 'string' && /^[+\-@]/.test(tool.context.trim())) {
    // The context itself looks like a diff
    return { diff: tool.context };
  }
  if (typeof tool.inlineDiff === 'string') {
    return { diff: tool.inlineDiff };
  }

  // 2) Inspect args and result for old/new pairs
  let args: Record<string, unknown> = {};
  if (tool.context) {
    try { args = JSON.parse(tool.context) as Record<string, unknown>; } catch { /* ignore */ }
  }
  const result = tool.result;

  // Result: { diff: '...' } or { patch: '...' } or the result itself is a string
  if (typeof result === 'string' && (result.includes('--- ') || result.includes('+++ ') || result.startsWith('@@'))) {
    return { diff: result };
  }
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.diff === 'string') return { diff: r.diff };
    if (typeof r.patch === 'string') return { diff: r.patch };
    if (typeof r.unifiedDiff === 'string') return { diff: r.unifiedDiff };
    if (typeof r.old === 'string' && typeof r.new === 'string') {
      return { oldContent: r.old, newContent: r.new };
    }
    if (typeof r.oldContent === 'string' && typeof r.newContent === 'string') {
      return { oldContent: r.oldContent, newContent: r.newContent };
    }
  }

  // 3) Args: { old_string, new_string } / { find, replace } / { patch } / { content } (no old → all added)
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };
  const oldString = pick('old_string', 'find', 'old', 'oldContent');
  const newString = pick('new_string', 'replace', 'new', 'newContent', 'content', 'patch');
  if (oldString !== undefined && newString !== undefined) {
    return { oldContent: oldString, newContent: newString };
  }
  if (newString !== undefined) {
    // write_file with no old → show as all-added
    return { oldContent: '', newContent: newString };
  }

  return null;
}

/**
 * Best-effort extraction of a human-written *intent* for a file edit, e.g.
 * "Add a note clarifying the document is self-contained". Some upstream
 * agents (and built-in tools, when wired) attach a short imperative
 * description to each edit; when present the rail row leads with it instead
 * of a bare "Editing <file>" verb. Returns null when the args carry no such
 * field — the caller falls back to the verb + filename chip.
 */
export function extractEditIntent(context?: string): string | null {
  if (!context) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(context);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const clean = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > 240 ? `${t.slice(0, 237).trimEnd()}…` : t;
  };

  // Top-level intent / description on the edit call.
  const topLevel = clean(
    obj.description ??
      obj.intent ??
      obj.change_summary ??
      obj.edit_summary ??
      obj.comment ??
      obj.title,
  );
  if (topLevel) return topLevel;

  // Multi-edit payloads: first item's own description (one rail row per call).
  for (const key of ['edits', 'changes', 'replacements', 'files']) {
    const list = obj[key];
    if (Array.isArray(list) && list[0] && typeof list[0] === 'object') {
      const item = list[0] as Record<string, unknown>;
      const perItem = clean(item.description ?? item.intent ?? item.comment);
      if (perItem) {
        return list.length > 1 ? `${perItem} (+${list.length - 1} more)` : perItem;
      }
    }
  }

  return null;
}
