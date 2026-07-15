/**
 * Build a one-paragraph end-of-turn "Recap" from activity already on the
 * message (tools, changed files, final prose). No LLM required.
 *
 * Example:
 *   We read 7 files, edited src/app.ts and styles.css, ran 1 command, and
 *   updated 2 files on disk.
 */

import { classifyTool, normalizeToolName } from '@/lib/tool-classify';
import { extractCommand, extractFilename } from '@/components/chat/ToolCallItem';
import type { ChatMessage, MessageBlock } from '@/types/chat';

export interface TurnRecapInput {
  blocks?: MessageBlock[] | null;
  tools?: ChatMessage['tools'];
  changedFiles?: {
    files?: Array<{ path: string; added?: number; removed?: number; status?: string }>;
  } | null;
  /** Final assistant prose (for light topical cue when activity is thin). */
  finalText?: string | null;
}

function basenames(paths: string[], max = 3): string {
  const names = paths
    .map((p) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p)
    .filter(Boolean);
  const unique = [...new Set(names)];
  if (unique.length === 0) return '';
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  const head = unique.slice(0, max - 1);
  const rest = unique.length - head.length;
  return rest > 1
    ? `${head.join(', ')}, and ${rest} more`
    : `${head.join(', ')}, and ${unique[max - 1]}`;
}

function collectToolLike(input: TurnRecapInput): Array<{ name: string; context?: string }> {
  const out: Array<{ name: string; context?: string }> = [];
  if (input.blocks?.length) {
    for (const b of input.blocks) {
      if ((b.type === 'toolCall' || b.type === 'command') && b.tool) {
        out.push({ name: b.tool.name, context: b.tool.context });
      }
    }
  }
  if (out.length === 0 && input.tools?.length) {
    for (const t of input.tools) {
      out.push({ name: t.name, context: t.context });
    }
  }
  return out;
}

/**
 * Returns a past-tense recap sentence, or null when there is nothing
 * meaningful to summarize (pure short answer with no tools/files).
 */
export function buildTurnRecap(input: TurnRecapInput): string | null {
  const tools = collectToolLike(input);
  const files = (input.changedFiles?.files ?? []).filter(
    (f) => f.path && ((f.added ?? 0) > 0 || (f.removed ?? 0) > 0 || f.status),
  );

  let viewed = 0;
  let edited = 0;
  let ran = 0;
  let used = 0;
  const viewPaths: string[] = [];
  const editPaths: string[] = [];
  const commands: string[] = [];

  for (const t of tools) {
    const bucket = classifyTool(t.name);
    const path = extractFilename(t.context) ?? undefined;
    if (bucket === 'view') {
      viewed++;
      if (path) viewPaths.push(path);
    } else if (bucket === 'edit') {
      edited++;
      if (path) editPaths.push(path);
    } else if (bucket === 'run') {
      ran++;
      const cmd = extractCommand(t.context);
      if (cmd) commands.push(cmd.trim().split(/\s+/)[0] || cmd.slice(0, 40));
    } else {
      used++;
    }
  }

  const clauses: string[] = [];

  if (viewed > 0) {
    const names = basenames(viewPaths);
    if (names && viewed <= 3) {
      clauses.push(viewed === 1 ? `read ${names}` : `read ${names}`);
    } else {
      clauses.push(viewed === 1 ? 'read 1 file' : `read ${viewed} files`);
    }
  }

  if (edited > 0 || files.length > 0) {
    const paths = editPaths.length
      ? editPaths
      : files.map((f) => f.path);
    const names = basenames(paths);
    if (names) {
      clauses.push(edited === 1 || paths.length === 1 ? `edited ${names}` : `edited ${names}`);
    } else {
      const n = Math.max(edited, files.length);
      clauses.push(n === 1 ? 'edited 1 file' : `edited ${n} files`);
    }
  }

  if (ran > 0) {
    const cmdNames = [...new Set(commands)].slice(0, 3);
    if (cmdNames.length === 1 && ran === 1) {
      clauses.push(`ran \`${cmdNames[0]}\``);
    } else if (cmdNames.length > 0) {
      clauses.push(
        ran === 1
          ? `ran ${cmdNames[0]}`
          : `ran ${ran} commands (${cmdNames.join(', ')})`,
      );
    } else {
      clauses.push(ran === 1 ? 'ran 1 command' : `ran ${ran} commands`);
    }
  }

  if (used > 0) {
    // Prefer concrete tool labels when few
    const special = tools
      .filter((t) => classifyTool(t.name) === 'tool')
      .map((t) => normalizeToolName(t.name).replace(/_/g, ' '))
      .slice(0, 2);
    if (special.length && used <= 2) {
      clauses.push(`used ${special.join(' and ')}`);
    } else {
      clauses.push(used === 1 ? 'used 1 other tool' : `used ${used} other tools`);
    }
  }

  if (files.length > 0 && editPaths.length === 0 && edited === 0) {
    // changedFiles present but no edit-classified tools
    const names = basenames(files.map((f) => f.path));
    if (names && !clauses.some((c) => c.includes('edited'))) {
      clauses.push(
        files.length === 1
          ? `updated ${names} on disk`
          : `updated ${files.length} files on disk`,
      );
    }
  }

  if (clauses.length === 0) {
    // No tools/files — skip pure chit-chat so the recap stays meaningful
    return null;
  }

  // Join like: "We A, B, and C."
  let body: string;
  if (clauses.length === 1) {
    body = clauses[0];
  } else if (clauses.length === 2) {
    body = `${clauses[0]} and ${clauses[1]}`;
  } else {
    body = `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
  }

  // Capitalize first letter after "We "
  const sentence = `We ${body}.`;
  return sentence.replace(/\s+/g, ' ').trim();
}

/** Build the user prompt for optional AI polish. */
export function buildAiRecapPrompt(template: string, input: TurnRecapInput): string {
  const tools = collectToolLike(input)
    .map((t) => {
      const path = extractFilename(t.context);
      const cmd = extractCommand(t.context);
      return `- ${t.name}${path ? ` path=${path}` : ''}${cmd ? ` cmd=${cmd.slice(0, 80)}` : ''}`;
    })
    .join('\n');
  const files = (input.changedFiles?.files ?? [])
    .map((f) => `- ${f.path} (+${f.added ?? 0}/-${f.removed ?? 0})`)
    .join('\n');
  const excerpt = (input.finalText || '').trim().slice(0, 400);

  return [
    'Write ONE short past-tense recap paragraph (1–2 sentences) of what was accomplished.',
    'Style example: "We fixed Google sign-in (workspace-mcp, OAuth callback, `.env` credentials), freed port 8085, and wrote the UI harness-parity plan in `docs/design/ui-harness-parity-plan.md`."',
    'Rules: no title, no bullet list, no "Recap:" prefix, no meta commentary, use backticks for paths/commands when natural.',
    '',
    `Draft: ${template}`,
    tools ? `Tools:\n${tools}` : '',
    files ? `Changed files:\n${files}` : '',
    excerpt ? `Answer excerpt:\n${excerpt}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
