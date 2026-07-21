import { useState, type ReactNode } from 'react';
import { Check, Loader2, FileSearch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DiffView } from '@/components/chat/DiffView';
import { confirmWorkbenchMutation } from '@/api/workbench';
import { visibleProgress, type ProgressEntry } from '@/lib/tool-progress';
import { formatToolContext } from '@/lib/tool-context-format';
import { classifyTool } from '@/lib/tool-classify';
import { ProviderSetupWidget } from '@/components/chat/ProviderSetupWidget';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { getAgentRoleLabel, pathBasename } from '@/lib/tool-labels';
import { isSubagentToolName } from '@/components/chat/subagent-tools';
import { extractDiffData, extractFilename, extractAgentId } from './extractors';
import type { ToolEntry } from './types';
import {
  Section,
  FormattedSection,
  FormattedResultSection,
  FormattedErrorSection,
} from './sections';

/** Pull the full prompt/task text out of a spawn_subagent tool's JSON args. */
function extractSubagentPrompt(context?: string): string | null {
  if (!context) return null;
  try {
    const parsed = JSON.parse(context);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      for (const key of ['task', 'prompt', 'description', 'goal', 'userMessage', 'message']) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
  } catch { /* not JSON */ }
  return null;
}

/** Subagent body: one container with a role header and nested
 *  PROMPT + SUBAGENT OUTPUT boxes. Replaces the generic context/result rows
 *  for spawn_subagent / run_team tool calls. */
function SubagentToolBody({ tool }: { tool: ToolEntry }) {
  const agentId = extractAgentId(tool.context) ?? undefined;
  const role = getAgentRoleLabel(agentId);
  const prompt = extractSubagentPrompt(tool.context);
  const output = tool.summary ?? '';

  return (
    <div className="mt-1.5 w-full max-w-2xl">
      <div className="flex items-center gap-1.5 text-[12px] leading-5 min-w-0">
        <span className="text-info/80">SubAgent</span>
        <span className="text-foreground font-semibold">{role}</span>
        {prompt && (
          <>
            <span className="text-muted-foreground/40 shrink-0">·</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground/70" title={prompt}>
              {prompt}
            </span>
          </>
        )}
      </div>

      <div className="mt-2 space-y-2">
        {prompt && (
          <div
            className="tool-result-scroll rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 max-h-56 overflow-y-auto overscroll-contain"
            onWheel={(e) => {
              if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) e.stopPropagation();
            }}
          >
            <div className="mb-1 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/55">
              Prompt
            </div>
            <div className="min-w-0 text-sm text-foreground/90 chat-message-text">
              <Markdown content={prompt} variant="assistant" />
            </div>
          </div>
        )}

        {output && (
          <div
            className="tool-result-scroll rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 max-h-56 overflow-y-auto overscroll-contain"
            onWheel={(e) => {
              if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) e.stopPropagation();
            }}
          >
            <div className="mb-1 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/55">
              Subagent output
            </div>
            <div className="min-w-0 text-sm text-foreground/90 chat-message-text">
              <Markdown content={output} variant="assistant" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


type SearchHit = { title: string; url: string; snippet?: string };

function searchResultsSummary(hits: SearchHit[]): string {
  if (hits.length === 1) {
    const hit = hits[0];
    if (hit.title) return hit.title;
    if (hit.url) {
      try {
        return new URL(hit.url).hostname;
      } catch {
        return hit.url;
      }
    }
    return '1 result';
  }
  const first = hits[0];
  const lead = first?.title || (first?.url ? (() => {
    try { return new URL(first.url).hostname; } catch { return first.url; }
  })() : null);
  return lead ? `${hits.length} results · ${lead}` : `${hits.length} results`;
}

/**
 * Search results — rendered directly (no second-level disclosure). This is
 * only ever mounted inside an already-expanded tool body, so requiring a
 * separate click to reveal the URLs just doubles the number of clicks
 * needed to read a search result with no benefit.
 */
function SearchResultsCard({ hits }: { hits: SearchHit[] }) {
  const summary = searchResultsSummary(hits);

  return (
    <div className="mt-1.5 max-w-full">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
        <FileSearch className="size-3 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </div>
      <div
        className="tool-result-scroll mt-1 max-w-2xl min-h-0 max-h-52 overflow-y-auto overscroll-contain rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2"
        onWheel={(e) => {
          if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) e.stopPropagation();
        }}
      >
        <ol className="m-0 grid list-none gap-2.5 p-0">
          {hits.map((hit, i) => (
            <li key={i} className="grid min-w-0 gap-1">
              <div className="flex items-start gap-2">
                {hit.url && (
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${new URL(hit.url).hostname}&sz=16`}
                    alt=""
                    className="size-4 shrink-0 mt-0.5 rounded"
                    width={16}
                    height={16}
                    loading="lazy"
                  />
                )}
                <div className="min-w-0 flex-1">
                  {hit.url ? (
                    <a
                      href={hit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-primary hover:underline truncate block"
                    >
                      {hit.title || new URL(hit.url).hostname}
                    </a>
                  ) : (
                    <span className="text-xs font-medium text-foreground/90">{hit.title}</span>
                  )}
                  {hit.url && (
                    <p className="text-[10px] text-muted-foreground/60 truncate mt-0.5">
                      {hit.url}
                    </p>
                  )}
                </div>
              </div>
              {hit.snippet && (
                <p className="text-[10px] text-muted-foreground line-clamp-3 m-0 pl-6">{hit.snippet}</p>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * Expanded tool-call body — context, progress, diffs, search hits, errors,
 * approval. Shared by ToolCallItem (legacy path) and ToolSummary drill-down.
 */
export function ToolCallItemBody({
  tool,
  progress,
}: {
  tool: ToolEntry;
  progress?: ReadonlyArray<ProgressEntry>;
  /** Reserved for callers that need subagent labeling in nested chrome. */
  agentIdOverride?: string;
}) {
  const [approvalStatus, setApprovalStatus] = useState<'idle' | 'confirming' | 'confirmed'>('idle');
  const isSubagent = isSubagentToolName(tool.name);
  const bucket = classifyTool(tool.name);
  const isView = bucket === 'view';
  const parts: ReactNode[] = [];

  if (isSubagent) {
    parts.push(<SubagentToolBody key="subagent" tool={tool} />);
  } else if (
    tool.context &&
    !isView &&
    !tool.name.match(/context_read|memory_search|read_file|search/)
  ) {
    // View/read tools: raw JSON input is noise — path lives in the row label.
    parts.push(
      <FormattedSection
        key="context"
        toolName={tool.name}
        label="context"
        raw={tool.context}
        format={formatToolContext}
      />,
    );
  }

  if (!isSubagent) {
    const visible = progress ? visibleProgress(progress) : [];
    const total = progress?.length ?? 0;
    const overflow = Math.max(0, total - visible.length);
    if (visible.length > 0) {
      parts.push(
        <div key="progress" className="my-1.5 space-y-0.5" aria-label="Tool progress" data-tool-progress>
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
            <FileSearch size={10} />
            <span>
              {tool.status === 'running' ? 'Exploring' : 'Files'}
            </span>
          </div>
          {visible.map((entry) => (
            <div
              key={entry.path}
              className="flex items-center gap-1.5 text-[11px] truncate"
              title={entry.path}
            >
              <span className="w-2.5 shrink-0 inline-flex justify-center">
                {entry.status === 'reading' ? (
                  <Loader2 size={10} className="animate-spin text-info" />
                ) : (
                  <Check size={10} className="text-muted-foreground/50" />
                )}
              </span>
              <span
                className={cn(
                  'truncate font-mono',
                  entry.status === 'reading' ? 'text-info italic' : 'text-muted-foreground/60 line-through'
                )}
              >
                {entry.status === 'reading' ? 'Reading ' : 'Read '}
                {pathBasename(entry.path)}
              </span>
            </div>
          ))}
          {overflow > 0 && (
            <div className="text-[10px] text-muted-foreground/50 italic pl-4">
              + {overflow} more
            </div>
          )}
        </div>,
      );
    }
  }

  // Streaming preview is useful for edits/commands, not for dumping file reads.
  if (!isSubagent && !isView && tool.preview && tool.status === 'running') {
    parts.push(
      <Section key="preview" label="streaming">
        {tool.preview}
        <span className="inline-block w-1.5 h-3 align-middle bg-foreground/40 ml-0.5 animate-pulse" />
      </Section>,
    );
  }

  let hasDiff = false;
  if (!isSubagent) {
    const diffData = extractDiffData(tool);
    if (diffData) {
      hasDiff = true;
      parts.push(
        <Section key="diff" label="diff">
          <DiffView
            diff={diffData.diff}
            oldContent={diffData.oldContent}
            newContent={diffData.newContent}
          />
        </Section>,
      );
    }
  }

  if (!isSubagent && tool.searchHits && tool.searchHits.length > 0) {
    parts.push(<SearchResultsCard key="search" hits={tool.searchHits} />);
  }

  // View/read tools: no truncated content preview — path is on the row label.
  // Edit tools route through DiffView above; other tools keep FormattedResult.
  if (
    !isSubagent &&
    !isView &&
    tool.summary &&
    !tool.searchHits &&
    !tool.providerSetup &&
    !hasDiff
  ) {
    parts.push(
      <FormattedResultSection key="result" toolName={tool.name} raw={tool.summary} />,
    );
  }

  if (tool.providerSetup) {
    parts.push(<ProviderSetupWidget key="provider" setup={tool.providerSetup} />);
  }

  if (tool.error) {
    parts.push(
      <FormattedErrorSection key="error" toolName={tool.name} raw={tool.error} />,
    );
  }

  if (
    tool.pendingApproval &&
    approvalStatus !== 'confirmed' &&
    !tool.pendingApproval.confirmationToken
  ) {
    parts.push(
      <div key="approval" className="mt-2">
        <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/10 p-2">
          <div className="text-xs text-foreground/90">
            {tool.pendingApproval.message ||
              'This change needs approval before it can run.'}
          </div>
          {tool.pendingApproval.detail && (
            <div className="text-[11px] font-mono text-muted-foreground wrap-anywhere">
              {tool.pendingApproval.detail}
            </div>
          )}
          <button
            type="button"
            disabled={approvalStatus !== 'idle'}
            className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-60"
            onClick={() => {
              const token = tool.pendingApproval?.confirmationToken;
              if (!token) return;
              setApprovalStatus('confirming');
              void confirmWorkbenchMutation(token, {
                onDone: () => setApprovalStatus('confirmed'),
                onError: ({ message }) => {
                  tool.error = message;
                },
              });
            }}
          >
            {approvalStatus === 'confirming' ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>,
    );
  }

  if (parts.length === 0) return null;

  return (
    <div className="mt-0.5 w-full min-w-0 max-w-full overflow-x-hidden wrap-anywhere pb-1">
      {parts}
    </div>
  );
}
