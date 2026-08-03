/**
 * EditRailRow — a file edit rendered as one compact row on the process rail,
 * with two faces:
 *
 *   collapsed:  ✎  <intent or verb>            [file chip]   +N -N
 *   expanded:   ✎  Wrote  🐍  file.py  tests/   +N -N   ⌄
 *               ┌──────────────────────────────────────────┐
 *               │  78 │  syntax-highlighted code (green)   │  ← DiffCodePanel
 *               └──────────────────────────────────────────┘
 *
 * The collapsed face leads with a human intent when the upstream agent
 * attaches one (else a present-tense verb) and carries the filename in a
 * chip — matching the summary-row reference. The expanded face becomes the
 * file-centric header (past-tense verb · language glyph · name · directory ·
 * counts · chevron) above a real syntax-highlighted code panel — matching the
 * code-view reference. The terminal "Done" marker for the whole turn is drawn
 * by RailDoneRow at the rail level, never per edit.
 *
 * Diff counts hide a zero side (a brand-new file shows "+470", not "+470 -0"),
 * and the chevron only appears when there is a body to expand into.
 */

import { useEffect, useId, useState } from 'react';
import { AlertCircle, ChevronRight, Loader2, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FileIcon } from '@/components/ui/FileIcon';
import { ToolCallItemBody, type ToolEntry } from '@/components/chat/ToolCallItem';
import { DiffCodePanel } from '@/components/chat/DiffCodePanel';
import {
  extractDiffData,
  extractEditIntent,
  extractFilename,
} from '@/components/chat/tool/extractors';
import { diffStats } from '@/components/chat/DiffView';

/** Split a path into basename + directory (forward-slash, trailing slash). */
function splitPath(full: string | null): { base: string; dir: string } {
  if (!full) return { base: '', dir: '' };
  const norm = full.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return { base: norm, dir: '' };
  return { base: norm.slice(idx + 1), dir: norm.slice(0, idx + 1) };
}

/** Present-tense verb for the leading slot when no intent is supplied.
 *  Derived from the tool name only — never the filename — so the filename
 *  column can carry the name without the verb duplicating it. */
function presentVerb(tool: ToolEntry): string {
  const n = tool.name.toLowerCase();
  if (/write|create/.test(n)) return 'Writing';
  if (/delete|remove/.test(n)) return 'Deleting';
  return 'Editing';
}

export function EditRailRow({
  tool,
  expanded,
}: {
  tool: ToolEntry;
  /** Parent-derived open hint (running → open). Seeds state; re-opens while
   *  running; completion never force-collapses. */
  expanded: boolean;
}) {
  const reactId = useId();
  const panelId = `edit-rail-panel-${tool.id || reactId}`;
  const running = tool.status === 'running';
  const errored = tool.status === 'error';

  const fullPath = extractFilename(tool.context);
  const { base, dir } = splitPath(fullPath);
  const intent = extractEditIntent(tool.context);
  const description = intent ?? presentVerb(tool);
  const stats = diffStats(extractDiffData(tool));
  const diffData = extractDiffData(tool);
  const hasBody = !!(diffData || tool.inlineDiff || tool.error || tool.pendingApproval);

  const [open, setOpen] = useState(expanded);
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);

  const isOpen = open && hasBody;

  const glyph = running ? (
    <Loader2 className="rail-glyph animate-spin" aria-hidden />
  ) : errored ? (
    <AlertCircle className="rail-glyph text-danger" aria-hidden />
  ) : (
    <Pencil className="rail-glyph" aria-hidden />
  );

  // Hide a zero side so a pure addition reads "+470" (not "+470 -0"). When
  // both sides are zero (context-only diff) nothing renders.
  const statsNode =
    stats && (stats.added > 0 || stats.removed > 0) ? (
      <span
        className="edit-rail-stats font-mono text-xs tabular-nums"
        aria-label={`${stats.added} added, ${stats.removed} removed`}
      >
        {stats.added > 0 ? <span className="text-success">+{stats.added}</span> : null}
        {stats.removed > 0 ? <span className="text-danger">-{stats.removed}</span> : null}
      </span>
    ) : null;

  return (
    <div
      className={cn(
        'rail-row edit-rail-row',
        running && 'edit-rail-row--running',
        errored && 'edit-rail-row--error',
      )}
      data-slot="edit-rail-row"
      data-status={tool.status}
      data-expanded={isOpen ? 'true' : 'false'}
    >
      <span className="rail-line" aria-hidden />
      <div className="rail-gutter" aria-hidden>
        <span className="rail-icon">{glyph}</span>
      </div>

      <div className="rail-row-body">
        <button
          type="button"
          className={cn(
            'group edit-rail-trigger',
            isOpen && 'edit-rail-trigger--open',
          )}
          onClick={() => hasBody && setOpen((o) => !o)}
          aria-expanded={isOpen}
          aria-controls={hasBody ? panelId : undefined}
          disabled={!hasBody}
          title={fullPath ?? undefined}
        >
          <span className="edit-rail-verb">{description}</span>
          {base ? (
            <FileIcon name={base} size={13} className="edit-rail-langicon" />
          ) : null}
          {base ? (
            <span className="edit-rail-filelink" title={fullPath ?? undefined}>
              {base}
            </span>
          ) : null}
          {dir ? (
            <span className="edit-rail-dir" title={fullPath ?? undefined}>
              {dir}
            </span>
          ) : null}
          {statsNode}
          {hasBody ? (
            <ChevronRight
              className={cn('edit-rail-chevron', isOpen && 'is-open')}
              aria-hidden
            />
          ) : null}
        </button>

        {isOpen ? (
          <div id={panelId} className="edit-rail-panel">
            {diffData ? (
              <DiffCodePanel
                diff={diffData.diff}
                oldContent={diffData.oldContent}
                newContent={diffData.newContent}
                filename={fullPath ?? undefined}
              />
            ) : null}
            {/* Approval / error only — diff + context are suppressed so the
                code panel is the single source of truth for the change. */}
            <ToolCallItemBody tool={tool} hideProgress hideDiff hideContext />
          </div>
        ) : null}
      </div>
    </div>
  );
}
