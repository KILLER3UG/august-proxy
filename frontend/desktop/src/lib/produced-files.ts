/**
 * Derive the files a turn "touched" from its tool-call blocks — the
 * light-weight deliverables row (dsh-style) that complements the git-based
 * ChangedFilesCard. Pure so it is unit-testable.
 *
 * A file counts when an edit-classified tool call carries a file path in
 * its args. Internal `.aug/` bookkeeping paths are excluded.
 */

import { classifyTool } from '@/lib/tool-classify';
import { extractFilename } from '@/components/chat/tool/extractors';
import type { MessageBlock } from '@/types/chat';

const AUG_INTERNAL = /(^|[\\/])\.aug([\\/]|$)/;

/** Unique, de-duplicated, display-ready paths in first-seen order. */
export function collectProducedFiles(blocks?: MessageBlock[] | null): string[] {
  if (!blocks) return [];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'toolCall' || !block.tool) continue;
    const name = block.tool.name || '';
    const bucket = classifyTool(name);
    // Edit-classified calls carry file paths in args. Office/creation tools
    // (pptx_*, docx generation via run_command scripts writing decks/docs)
    // surface their output path too — those are deliverables like any other.
    const isEdit = bucket === 'edit';
    const isOfficeDeliverable =
      typeof name === 'string' &&
      /^pptx_/i.test(name) &&
      extractFilename(block.tool.context) != null;
    if (!isEdit && !isOfficeDeliverable && !/^create_html_artifact$/i.test(name)) continue;
    const path = extractFilename(block.tool.context);
    if (!path) continue;
    if (AUG_INTERNAL.test(path)) continue;
    const key = path.replace(/\\/g, '/').replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(path);
  }
  return files;
}

/** Short display label for a path (basename; falls back to the path). */
export function producedFileLabel(path: string): string {
  const cleaned = path.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return cleaned || path;
}
