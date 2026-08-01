/**
 * DiffCodePanel — an inline file diff rendered as a real code panel: a
 * scroll-capped window with a per-line left accent bar, a line-number gutter,
 * and syntax-highlighted code (via the shared highlight.js setup). Added /
 * removed / context lines are tinted green / red / neutral so a brand-new
 * file reads as an all-green panel and an in-place edit shows the changed
 * hunks in colour — the look from the reference screenshot.
 *
 * Theme-aware: tints are mixed from the `--dt-success` / `--dt-danger` /
 * `--dt-code-block-*` tokens so it tracks light/dark like the rest of the UI.
 *
 * This is the *chat edit* diff view. The shared <DiffView> (used by the
 * workbench, permission cards, changed-files, …) is intentionally left as-is.
 */

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  countDiffLines,
  diffLines,
  parseUnifiedDiff,
  type DiffLine,
} from '@/components/chat/DiffView';
import { highlightCode, languageForFilename } from '@/lib/code-highlight';

export interface DiffCodePanelProps {
  diff?: string;
  oldContent?: string;
  newContent?: string;
  /** Filename (or path) — drives syntax-language detection. */
  filename?: string;
  /** Soft cap on rendered lines; the rest sit behind a "show more" affordance. */
  maxLines?: number;
  className?: string;
}

function lineNumber(line: DiffLine): number | undefined {
  return line.kind === 'removed' ? line.oldLine : line.newLine;
}

export function DiffCodePanel({
  diff,
  oldContent,
  newContent,
  filename,
  maxLines = 300,
  className,
}: DiffCodePanelProps) {
  const lines = useMemo<DiffLine[]>(() => {
    if (diff) return parseUnifiedDiff(diff);
    if (oldContent !== undefined && newContent !== undefined) {
      return diffLines(oldContent, newContent);
    }
    return [];
  }, [diff, oldContent, newContent]);

  const counts = useMemo(() => countDiffLines(lines), [lines]);
  const lang = useMemo(() => languageForFilename(filename), [filename]);
  const [expanded, setExpanded] = useState(false);

  if (lines.length === 0) return null;

  const visible = expanded ? lines : lines.slice(0, maxLines);
  const hidden = lines.length - visible.length;

  return (
    <div
      className={cn('diff-code-panel', className)}
      role="region"
      aria-label={`Diff${filename ? ` ${filename}` : ''}: +${counts.added} -${counts.removed}`}
    >
      <div className="diff-code-scroll tool-result-scroll">
        {visible.map((line, i) => {
          const html = line.text ? highlightCode(line.text, lang) : '&nbsp;';
          return (
            <div key={i} className={cn('diff-code-row', `diff-code-row--${line.kind}`)}>
              <span className="diff-code-accent" aria-hidden />
              <span className="diff-code-num" aria-hidden>
                {lineNumber(line) ?? ''}
              </span>
              <code
                className="diff-code-text"
                // highlight.js output is already escaped; injected as-is so the
                // theme's `.hljs-*` token colours apply. No `.hljs` parent is
                // used, so the theme's base background never paints over the
                // per-row tint — only the token spans carry colour.
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          );
        })}
      </div>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="diff-code-more"
        >
          Show {hidden} more line{hidden === 1 ? '' : 's'}
        </button>
      )}
      {expanded && lines.length > maxLines && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="diff-code-more"
        >
          Show less
        </button>
      )}
    </div>
  );
}
