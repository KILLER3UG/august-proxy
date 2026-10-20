/**
 * Derive the files a turn "touched" from its tool-call blocks — the
 * row source for the unified ChangesCard. Pure so it is
 * unit-testable.
 *
 * A file counts when an edit-classified tool call carries a file path in
 * its args. Internal `.aug/` bookkeeping paths are excluded.
 */

import { producedFilePath } from '@/lib/produced-artifacts';
import type { MessageBlock } from '@/types/chat';

/** Unique, de-duplicated, display-ready paths in first-seen order.
 *
 *  The rule for "a file a tool wrote" is ONE implementation, in
 *  lib/produced-artifacts.ts (`producedFilePath`): an EDIT-classified
 *  call, an office deliverable (`pptx_*`) or `create_html_artifact`,
 *  carrying a path. This file used to hold its own copy of that rule and
 *  the artifact collector held a third; they agreed by luck, and a
 *  disagreement would have shown the same file in two places at once. */
export function collectProducedFiles(blocks?: MessageBlock[] | null): string[] {
  if (!blocks) return [];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'toolCall' || !block.tool) continue;
    const path = producedFilePath(block.tool.name || '', block.tool.context);
    if (!path) continue;
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
