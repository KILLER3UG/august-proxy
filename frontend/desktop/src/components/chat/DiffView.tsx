/* eslint-disable react-refresh/only-export-components */

/* ── DiffView ─ inline unified / line-based diff renderer ─────────── */
/* Renders a diff in the same style as the ZCode reference:              */
/*   • line numbers in a muted right-aligned column                      */
/*   • removed lines: rgba(248,113,113,0.09) bg + 2-px #f87171 border    */
/*   • added   lines: rgba(74,222,128,0.09) bg + 2-px #4ade80 border    */
/*   • container:  rgba(0,0,0,0.3) on the already-dark surface           */
/*   • ─── N more lines ─── truncation after `maxLines`                  */
/*                                                                       */
/* Accepts either:                                                        */
/*   1. a pre-formatted unified diff string (`diff` prop), or            */
/*   2. an `oldContent` / `newContent` pair (computes the diff inline),  */
/*   3. a `null` / `undefined` (renders nothing).                        */

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * Line-based diff between two files. Uses common-prefix + common-suffix,
 * which handles the common case of "change a few lines in the middle of
 * an otherwise-unchanged file" — the typical shape of a tool-driven edit.
 */
function splitLines(text: string): string[] {
  // Equivalent of String.prototype.splitlines(), which isn't in our ES target.
  // Drops the trailing empty that split('\n') adds when the input doesn't
  // end with a newline; keeps an actual trailing empty line if the input is
  // a single '\n' (which splitlines() would also return [] for).
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '' && !text.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  const maxSuffix = Math.min(oldLines.length - prefix, newLines.length - prefix);
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: DiffLine[] = [];

  for (let i = 0; i < prefix; i++) {
    out.push({ kind: 'context', text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }
  for (let i = prefix; i < oldLines.length - suffix; i++) {
    out.push({ kind: 'removed', text: oldLines[i], oldLine: i + 1 });
  }
  for (let i = prefix; i < newLines.length - suffix; i++) {
    out.push({ kind: 'added', text: newLines[i], newLine: i + 1 });
  }
  for (let i = suffix; i > 0; i--) {
    const oldIdx = oldLines.length - i;
    const newIdx = newLines.length - i;
    out.push({ kind: 'context', text: oldLines[oldIdx], oldLine: oldIdx + 1, newLine: newIdx + 1 });
  }

  return out;
}

/** Parse a unified-diff string (the output of `git diff`, `diff -u`, etc.) into DiffLine[]. */
export function parseUnifiedDiff(text: string): DiffLine[] {
  const lines = text.split('\n');
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of lines) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
    if (raw.startsWith('@@')) {
      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@ optional section
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) continue;

    if (raw.startsWith('+')) {
      out.push({ kind: 'added', text: raw.slice(1), newLine: newLine++ });
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'removed', text: raw.slice(1), oldLine: oldLine++ });
    } else if (raw.startsWith(' ') || raw === '') {
      out.push({
        kind: 'context',
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  return out;
}

export interface DiffViewProps {
  /** Pre-formatted unified diff string. Wins over oldContent/newContent. */
  diff?: string;
  /** Old file content. Used with newContent to compute the diff. */
  oldContent?: string;
  /** New file content. */
  newContent?: string;
  /** Maximum number of lines to render before showing the "─── N more lines ───" truncation. Default: 40. */
  maxLines?: number;
  className?: string;
}

export function DiffView({ diff, oldContent, newContent, maxLines = 40, className }: DiffViewProps) {
  const lines = useMemo<DiffLine[]>(() => {
    if (diff) return parseUnifiedDiff(diff);
    if (oldContent !== undefined && newContent !== undefined) {
      return diffLines(oldContent, newContent);
    }
    return [];
  }, [diff, oldContent, newContent]);

  const counts = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const l of lines) {
      if (l.kind === 'added') added++;
      else if (l.kind === 'removed') removed++;
    }
    return { added, removed };
  }, [lines]);

  const [expanded, setExpanded] = useState(false);

  if (lines.length === 0) return null;

  const visible = expanded ? lines : lines.slice(0, maxLines);
  const hidden = lines.length - visible.length;

  return (
    <div
      className={cn(
        'rounded-md overflow-x-auto my-1.5 font-mono text-[11px] leading-[1.55]',
        'bg-black/30 border border-white/[0.04]',
        className
      )}
      role="region"
      aria-label={`Diff: +${counts.added} -${counts.removed}`}
    >
      {visible.map((line, i) => (
        <DiffLineRow key={i} line={line} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full text-[10px] text-zinc-500 hover:text-zinc-300 text-center py-1.5 select-none cursor-pointer transition-colors"
        >
          ─── Show {hidden} more line{hidden === 1 ? '' : 's'} ───
        </button>
      )}
      {expanded && lines.length > maxLines && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full text-[10px] text-zinc-500 hover:text-zinc-300 text-center py-1.5 select-none cursor-pointer transition-colors"
        >
          ─── Show less ───
        </button>
      )}
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const lineNumber = line.kind === 'removed' ? line.oldLine : line.newLine;
  const prefix = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';

  return (
    <div className="flex hover:bg-white/[0.025]">
      <span
        className={cn(
          'text-zinc-500 text-right min-w-[2.25rem] pr-2 select-none tabular-nums shrink-0',
          'border-r border-white/[0.04]'
        )}
      >
        {lineNumber ?? ''}
      </span>
      <span
        className={cn(
          'px-1.5 border-l-2 flex-1 whitespace-pre',
          line.kind === 'added' &&
            'border-success text-success',
          line.kind === 'removed' &&
            'border-danger text-danger',
          line.kind === 'context' && 'border-transparent text-zinc-300'
        )}
        style={
          line.kind === 'added'
            ? { backgroundColor: 'rgba(74,222,128,0.09)' }
            : line.kind === 'removed'
              ? { backgroundColor: 'rgba(248,113,113,0.09)' }
              : undefined
        }
      >
        <span className="opacity-50 select-none">{prefix}</span> {line.text || ' '}
      </span>
    </div>
  );
}
