import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, Check, ChevronDown, CircleDot, Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { ToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon } from '@/components/ui/FileIcon';
import type { ToolEntry } from '@/components/chat/ToolCallItem';
import { extractCommand, extractFilename } from '@/components/chat/ToolCallItem';
import { getToolLabel } from '@/lib/tool-labels';
import { formatToolContext } from '@/lib/tool-context-format';
import { classifyTool } from '@/lib/tool-classify';

const STALL_MS = 120_000;
/** Delay before auto-collapsing once a live group settles cleanly. */
export const SETTLE_COLLAPSE_MS = 300;
/** Above this length, skip per-label shimmer (noisy on long commands). */
const LONG_LABEL_THRESHOLD = 40;

export interface ToolSummaryEntry {
  id: string;
  toolEntry: ToolEntry;
  label: string;
  detail: string;
  filename?: string | null;
  isCommand?: boolean;
  status: 'running' | 'done' | 'error';
  stalled?: boolean;
  awaitingApproval?: boolean;
  duration?: number;
}

export interface ToolSummaryProps {
  thoughtCount: number;
  viewedCount: number;
  editedCount: number;
  ranCount: number;
  usedCount: number;
  entries: ToolSummaryEntry[];
  /** True while any tool is running / awaiting, or the parent turn is still streaming this group. */
  isLive?: boolean;
  renderToolBody: (tool: ToolEntry) => ReactNode;
  renderAfterRow?: (entry: ToolSummaryEntry) => ReactNode;
}

/** Exported for unit tests. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function formatDurationShort(ms?: number): string | null {
  if (ms === undefined || ms < 1000) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return reduced;
}

/** Build a summary row from a tool entry (shared by ChatThread). */
export function buildToolSummaryEntry(
  tool: ToolEntry,
  opts?: { agentIdOverride?: string; now?: number },
): ToolSummaryEntry {
  const isCommand =
    tool.name.startsWith('@run_command') ||
    tool.name.startsWith('run_command') ||
    classifyTool(tool.name) === 'run';
  const commandText = isCommand ? extractCommand(tool.context) : null;
  const filename = !isCommand ? extractFilename(tool.context) : null;
  const agentId = opts?.agentIdOverride;

  const label = getToolLabel(tool.name, {
    agentId: agentId ?? undefined,
    filename: filename ?? undefined,
    command: commandText ?? undefined,
    status: tool.status,
  });

  const friendlyCtx = tool.context ? formatToolContext(tool.name, tool.context) : null;
  const detail =
    friendlyCtx?.summary ??
    commandText ??
    filename ??
    (tool.context && tool.context.length > 80
      ? `${tool.context.slice(0, 77).trimEnd()}…`
      : tool.context ?? '');

  const now = opts?.now ?? Date.now();
  let startedAtMs: number | undefined;
  if (typeof tool.startedAt === 'number') startedAtMs = tool.startedAt;
  const stalled =
    tool.status === 'running' &&
    startedAtMs !== undefined &&
    now - startedAtMs > STALL_MS;

  return {
    id: tool.id,
    toolEntry: tool,
    label,
    detail,
    filename,
    isCommand,
    status: tool.status,
    stalled,
    awaitingApproval: !!(tool.pendingApproval && tool.status === 'running'),
    duration: tool.duration,
  };
}

export function ToolSummary({
  thoughtCount,
  viewedCount,
  editedCount,
  ranCount,
  usedCount,
  entries,
  isLive = false,
  renderToolBody,
  renderAfterRow,
}: ToolSummaryProps) {
  // null = follow auto policy; boolean = user override
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const reducedMotion = usePrefersReducedMotion();

  const hasError = entries.some((e) => e.status === 'error');
  const hasAwaiting = entries.some((e) => e.awaitingApproval);
  const hasStalled = entries.some((e) => e.stalled);
  const anyRunning = entries.some((e) => e.status === 'running');
  const needsAttention = hasError || hasAwaiting || hasStalled;
  const wantAutoOpen = isLive || needsAttention;

  // Delayed settle-collapse: open immediately when live/attention; wait 300ms
  // after quiet settle before auto-closing so completion doesn't flash shut.
  const [delayedAutoOpen, setDelayedAutoOpen] = useState(wantAutoOpen);
  useEffect(() => {
    if (wantAutoOpen) {
      setDelayedAutoOpen(true);
      return;
    }
    const id = window.setTimeout(() => setDelayedAutoOpen(false), SETTLE_COLLAPSE_MS);
    return () => window.clearTimeout(id);
  }, [wantAutoOpen]);

  const autoExpanded = delayedAutoOpen;
  const expanded = userExpanded ?? autoExpanded;

  // When a new error / approval appears, ensure those rows are open
  useEffect(() => {
    const forceOpen = entries
      .filter((e) => e.status === 'error' || e.awaitingApproval)
      .map((e) => e.id);
    if (forceOpen.length === 0) return;
    setExpandedIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of forceOpen) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [entries]);

  // New live phase: re-follow auto open (drop sticky user-closed while streaming)
  useEffect(() => {
    if (isLive) {
      setUserExpanded(null);
    }
  }, [isLive]);

  const countSegments = useMemo(() => {
    const segs: Array<{ key: string; text: string }> = [];
    if (thoughtCount > 0) segs.push({ key: 'thought', text: plural(thoughtCount, 'thought', 'thoughts') });
    if (viewedCount > 0) segs.push({ key: 'viewed', text: plural(viewedCount, 'viewed', 'viewed') });
    if (editedCount > 0) segs.push({ key: 'edited', text: plural(editedCount, 'edited', 'edited') });
    if (ranCount > 0) segs.push({ key: 'ran', text: plural(ranCount, 'ran', 'ran') });
    if (usedCount > 0) segs.push({ key: 'used', text: plural(usedCount, 'used', 'used') });
    return segs;
  }, [thoughtCount, viewedCount, editedCount, ranCount, usedCount]);

  const errorCount = entries.filter((e) => e.status === 'error').length;

  const attention: 'error' | 'warning' | 'none' = hasError
    ? 'error'
    : hasAwaiting || hasStalled
      ? 'warning'
      : 'none';

  const panelTransition = reducedMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const };
  const rowTransition = reducedMotion
    ? { duration: 0 }
    : { duration: 0.16, ease: [0.16, 1, 0.3, 1] as const };

  const toggleCard = () => {
    setUserExpanded(!expanded);
  };

  const toggleRow = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (countSegments.length === 0 && entries.length === 0) return null;

  return (
    <div
      className={cn('tool-summary', expanded && 'tool-summary--expanded')}
      data-slot="tool-summary"
      data-expanded={expanded ? 'true' : 'false'}
      data-live={isLive || anyRunning ? 'true' : 'false'}
      data-attention={attention}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
    >
      <button
        type="button"
        className="tool-summary-header"
        onClick={toggleCard}
        aria-expanded={expanded}
      >
        <span
          className={cn(
            'tool-summary-counts',
            (isLive || anyRunning) && !reducedMotion && 'shimmer',
          )}
        >
          {countSegments.map((s, i) => (
            <span key={s.key}>
              {i > 0 && <span className="tool-summary-sep" aria-hidden> · </span>}
              {s.text}
            </span>
          ))}
        </span>

        <span className="tool-summary-header-trailing">
          {hasError && (
            <span className="inline-flex items-center gap-1 text-destructive" title={`${errorCount} failed`}>
              <AlertCircle className="size-3" />
              {errorCount > 1 && <span className="text-[10px]">{errorCount}</span>}
            </span>
          )}
          {!hasError && hasAwaiting && (
            <span className="inline-flex items-center gap-1 text-warning" title="Needs approval">
              <CircleDot className="size-3 animate-pulse" />
            </span>
          )}
          {!hasError && !hasAwaiting && hasStalled && (
            <span className="inline-flex items-center gap-1 text-warning" title="Stalled">
              <AlertCircle className="size-3" />
            </span>
          )}
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground',
              !reducedMotion && 'transition-transform duration-200',
              expanded && 'rotate-180',
            )}
            aria-hidden
          />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="tool-summary-body"
            initial={reducedMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={panelTransition}
            className="overflow-hidden"
          >
            <div className="tool-summary-divider" />
            <div className="tool-summary-rows">
              {entries.map((entry) => {
                const rowOpen = expandedIds.has(entry.id);
                const toolNameForIcon = entry.toolEntry.name.replace(/^@/, '');
                const dur = formatDurationShort(entry.duration);
                const shortRunning =
                  entry.status === 'running' &&
                  entry.label.length < LONG_LABEL_THRESHOLD &&
                  !reducedMotion;
                return (
                  <div key={entry.id} data-status={entry.status}>
                    <button
                      type="button"
                      className={cn(
                        'tool-summary-row',
                        entry.status === 'error' && 'tool-summary-row--error',
                        entry.awaitingApproval && 'tool-summary-row--awaiting',
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRow(entry.id);
                      }}
                      aria-expanded={rowOpen}
                      title={entry.detail || entry.label}
                    >
                      <span className="shrink-0 mt-0.5">
                        {entry.filename ? (
                          <FileIcon name={entry.filename} size={14} className="shrink-0" />
                        ) : (
                          <ToolIcon
                            name={toolNameForIcon}
                            kind={entry.isCommand ? 'command' : 'tool'}
                            size={14}
                            className="shrink-0"
                          />
                        )}
                      </span>
                      <span
                        className={cn(
                          'tool-summary-row-label shrink-0',
                          shortRunning && 'shimmer',
                        )}
                      >
                        {entry.label}
                      </span>
                      {entry.detail && (
                        <span className="tool-summary-row-detail" title={entry.detail}>
                          {entry.detail}
                        </span>
                      )}
                      {dur && (
                        <span className="tool-summary-row-dur shrink-0">{dur}</span>
                      )}
                      <span className="tool-summary-row-status shrink-0">
                        <RowStatusGlyph entry={entry} />
                      </span>
                    </button>
                    <AnimatePresence initial={false}>
                      {rowOpen && (
                        <motion.div
                          key={`${entry.id}-body`}
                          initial={reducedMotion ? false : { opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                          transition={rowTransition}
                          // Clip during height anim, but don't trap nested scroll panes
                          // (search results / list_skills max-h containers).
                          className="overflow-x-hidden"
                        >
                          <div className="tool-summary-body">
                            {renderToolBody(entry.toolEntry)}
                            {renderAfterRow?.(entry)}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RowStatusGlyph({ entry }: { entry: ToolSummaryEntry }) {
  if (entry.stalled) {
    return <AlertCircle className="size-3 text-warning" aria-label="stalled" />;
  }
  if (entry.awaitingApproval) {
    return <CircleDot className="size-3 text-warning animate-pulse" aria-label="awaiting approval" />;
  }
  if (entry.status === 'running') {
    return <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="running" />;
  }
  if (entry.status === 'error') {
    return <AlertCircle className="size-3 text-destructive" aria-label="failed" />;
  }
  if (entry.status === 'done') {
    return <Check className="size-3 text-success/80" aria-label="done" />;
  }
  return null;
}
