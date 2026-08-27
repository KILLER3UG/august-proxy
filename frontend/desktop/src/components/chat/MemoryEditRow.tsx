/**
 * MemoryEditRow — a model memory write (`remember` / `save_fact` / `forget`)
 * rendered as one compact rail row (plan §4.1 "Memory write" class):
 *
 *   collapsed:  🧠  Saved memory        [entry title]
 *   expanded:   🧠  Saved memory        [entry title]   ⌄
 *               ┌──────────────────────────────────────┐
 *               │  the saved entry text                │
 *               │  key · category                      │
 *               └──────────────────────────────────────┘
 *
 * Expanded by default — the saved entry text is the point of the row
 * (the edit-class exception to the minimal-output rule).
 */

import { useEffect, useId, useState } from 'react';
import { AlertCircle, Brain, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type ToolEntry } from '@/components/chat/ToolCallItem';

function parseJsonObj(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function MemoryEditRow({
  tool,
  expanded,
}: {
  tool: ToolEntry;
  /** Parent-derived open hint. Seeds state; re-opens while running;
   *  completion never force-collapses. */
  expanded: boolean;
}) {
  const reactId = useId();
  const panelId = `memory-rail-panel-${tool.id || reactId}`;
  const running = tool.status === 'running';
  const errored = tool.status === 'error';

  const input = parseJsonObj(tool.context);
  const result = parseJsonObj(tool.summary) ?? parseJsonObj(tool.error);
  const fact = asString(input?.fact) || asString(input?.value);
  const title =
    asString(input?.title) ||
    (fact ? (fact.length > 80 ? `${fact.slice(0, 79).trimEnd()}…` : fact) : '') ||
    'Memory';
  const key = asString(result?.key);
  const category = asString(result?.category) || asString(input?.category);
  const updated = result?.updated === true;
  const hasBody = !!(fact || key || (errored && tool.error));

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
    <Brain className="rail-glyph" aria-hidden />
  );

  const verb = errored
    ? 'Failed to save memory'
    : running
      ? 'Saving memory'
      : updated
        ? 'Updated memory'
        : 'Saved memory';

  return (
    <div
      className={cn('rail-row edit-rail-row', errored && 'edit-rail-row--error')}
      data-slot="memory-rail-row"
      data-status={tool.status}
      data-expanded={isOpen ? 'true' : 'false'}
      data-testid="memory-rail-row"
    >
      <span className="rail-line" aria-hidden />
      <div className="rail-gutter" aria-hidden>
        <span className="rail-icon">{glyph}</span>
      </div>

      <div className="rail-row-body">
        <button
          type="button"
          className={cn('group edit-rail-trigger', isOpen && 'edit-rail-trigger--open')}
          onClick={() => hasBody && setOpen((o) => !o)}
          aria-expanded={isOpen}
          aria-controls={hasBody ? panelId : undefined}
          disabled={!hasBody}
          title={title}
        >
          <span className="edit-rail-verb">{verb}</span>
          <span className="edit-rail-filelink min-w-0 truncate" title={title}>
            {title}
          </span>
          {category ? (
            <span className="edit-rail-dir shrink-0">{category}</span>
          ) : null}
          {hasBody ? (
            <ChevronRight
              className={cn('edit-rail-chevron', isOpen && 'is-open')}
              aria-hidden
            />
          ) : null}
        </button>

        {isOpen ? (
          <div id={panelId} className="edit-rail-panel">
            {fact ? (
              <div className="whitespace-pre-wrap break-words rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[12px] leading-relaxed text-foreground/85">
                {fact}
              </div>
            ) : null}
            {key ? (
              <div className="mt-1 font-mono text-[10.5px] text-muted-foreground/70">
                {key}
              </div>
            ) : null}
            {errored && tool.error ? (
              <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-rose-400">
                {tool.error}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
