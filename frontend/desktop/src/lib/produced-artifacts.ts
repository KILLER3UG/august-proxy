/* ── produced-artifacts — what a tool call PRODUCED, read from its result ── */
/* The argument-side collector (lib/produced-files.ts) answers "which file  */
/* did an EDIT-classified call write?" — it reads the path out of the call's  */
/* ARGUMENTS, which is why it has to be gated on the tool's class: a         */
/* `read_file` carries a path argument too, and reading a file produced       */
/* nothing.                                                                  */
/*                                                                          */
/* This module is the other half: a tool that says in its RESULT what it     */
/* made. `create_html_artifact` answers `{"path": "...", "bytes": 4096}`,    */
/* the pptx tool answers `{"path": "...", "slideCount": 12}`, and a tool of   */
/* someone's own answers whatever it likes — the RESULT is what the tool     */
/* produced; the arguments are only what it was asked for.                   */
/*                                                                          */
/* The rules that keep a read out:                                           */
/*                                                                          */
/*   - a 'view' tool (read_file, list_files, web_search, …) produces nothing, */
/*     so it is skipped whatever its result says;                             */
/*   - a result that carries the file's CONTENT is a read, whatever else it  */
/*     says (`circuit_read_source` answers `{"path": …, "content": …}`);     */
/*   - a result that is not JSON names no file at all.                       */
/*                                                                          */
/* And the caption: the producing tool's own words about what it made. A     */
/* structured result carries them in a named field. A bare status word ("ok") */
/* is not a caption, and a tool that wrote no prose has no caption — there is */
/* nothing to invent one from.                                               */

import { classifyTool } from '@/lib/tool-classify';
import { extractFilename } from '@/components/chat/tool/extractors';
import { parseToolResult } from '@/lib/circuit-artifacts';

/** The subset of `ChatMessage['tools']` this module needs. */
export interface ProducedToolEntry {
  name?: string;
  context?: string;
  status?: string;
  /** Full, untruncated result text — see `makeStreamHandlers.onToolResult`. */
  result?: string;
  summary?: string;
}

/** Internal `.aug/` bookkeeping paths are not artifacts. */
const AUG_INTERNAL = /(^|[\\/])\.aug([\\/]|$)/;

/**
 * The path a tool call WROTE, read from its input.
 *
 * This is the app's rule for "a file a tool wrote" (lib/produced-files.ts):
 * an EDIT-classified call, an office deliverable (`pptx_*`) or
 * `create_html_artifact`, carrying a path. A `read_file` carries a path too
 * and is classified 'view', so it never qualifies.
 *
 * One implementation, used by the artifact collector AND by the activity
 * phrase (lib/tool-summary.ts), so the phrase and the cards cannot disagree
 * about what a turn produced.
 */
export function producedFilePath(name: string, context?: string): string | null {
  if (!name) return null;
  const bucket = classifyTool(name);
  const isOfficeDeliverable = /^pptx_/i.test(name) && extractFilename(context) != null;
  if (bucket !== 'edit' && !isOfficeDeliverable && !/^create_html_artifact$/i.test(name)) return null;
  const path = extractFilename(context);
  if (!path) return null;
  if (AUG_INTERNAL.test(path)) return null;
  return path;
}

/** A file a tool call produced, and the prose it wrote about it. */
export interface ProducedArtifact {
  path: string;
  /** The producing tool's own words about the file, when it wrote any. */
  caption?: string;
}

/**
 * Keys that name a file the tool WROTE.
 *
 * `savedTo` is the backend's own word for it (firmware and circuit tools
 * answer with it); the rest are the names a tool of someone's own would
 * reach for. `path` is last and is the weakest of them — it is also what a
 * tool answers when it only READ a file, which is what the content rule
 * below is for.
 */
const PRODUCED_KEYS = [
  'savedTo',
  'writtenTo',
  'wroteTo',
  'outputPath',
  'outputFile',
  'createdFile',
  'renderedFile',
  'artifactPath',
  'exportedTo',
  'svgFile',
  'imageFile',
  'pdfFile',
  'htmlFile',
  'filePath',
  'path',
];

/** Keys that carry the file's CONTENT — a result with one of these is a read. */
const CONTENT_KEYS = ['content', 'text', 'body', 'stdout', 'stderr'];

/** Fields that carry a line of PROSE about what the tool made. */
const CAPTION_KEYS = ['caption', 'description', 'note', 'explanation'];

/** A caption is one muted line under the content, not a paragraph. */
const MAX_CAPTION_CHARS = 240;

/** A status word is not a caption. */
const STATUS_WORDS = new Set(['ok', 'okay', 'done', 'success', 'saved', 'written', 'true']);

/**
 * The tool's own prose about what it did — the result text, when the result
 * IS prose rather than a structured payload.
 *
 * A structured result carries its prose in a named field (CAPTION_KEYS); this
 * is the other shape: the tool answered with a sentence, and that sentence
 * is the caption. A bare status word is not a caption, and neither is a
 * path — a caption is a line a person reads.
 */
export function proseFromResult(result?: string): string | undefined {
  if (!result) return undefined;
  const text = result.trim();
  // A single path is not a sentence.
  if (text.length < 16 || !text.includes(' ')) return undefined;
  if (STATUS_WORDS.has(text.toLowerCase())) return undefined;
  // A structured payload is not prose.
  if (text.startsWith('{') || text.startsWith('[')) return undefined;
  const line = text.replace(/\s+/g, ' ');
  return line.length > MAX_CAPTION_CHARS ? `${line.slice(0, MAX_CAPTION_CHARS - 1)}…` : line;
}

/** The first production-named path in the result, if the result names one. */
function firstProducedPath(data: Record<string, unknown>): string | null {
  for (const key of PRODUCED_KEYS) {
    const v = data[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** True when the result carries the file's own content — a read. */
function carriesContent(data: Record<string, unknown>): boolean {
  for (const key of CONTENT_KEYS) {
    if (data[key] !== undefined) return true;
  }
  return false;
}

/** The producing tool's own words, as one line. */
function captionFrom(data: Record<string, unknown>): string | undefined {
  for (const key of CAPTION_KEYS) {
    const v = data[key];
    if (typeof v !== 'string') continue;
    const line = v.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    return line.length > MAX_CAPTION_CHARS ? `${line.slice(0, MAX_CAPTION_CHARS - 1)}…` : line;
  }
  return undefined;
}

/**
 * The files a turn's tool calls PRODUCED, read out of their results.
 *
 * Deduped by path, first occurrence wins — the same path produced twice in
 * a turn is one artifact.
 */
export function collectResultArtifacts(
  tools?: ProducedToolEntry[] | null,
): ProducedArtifact[] {
  if (!tools?.length) return [];
  const seen = new Set<string>();
  const out: ProducedArtifact[] = [];
  for (const entry of tools) {
    const name = entry.name || '';
    if (!name) continue;
    // A read produces nothing, whatever its result says.
    if (classifyTool(name) === 'view') continue;
    // An errored tool wrote nothing; `result` still carries the failure text.
    if (entry.status && entry.status !== 'done') continue;
    const data = parseToolResult(entry.result);
    if (!data) continue;
    if (carriesContent(data)) continue;
    const path = firstProducedPath(data);
    if (!path) continue;
    const key = path.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, caption: captionFrom(data) });
  }
  return out;
}
