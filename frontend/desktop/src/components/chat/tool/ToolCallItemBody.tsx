import { useState } from 'react';
import { Check, Loader2, FileSearch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DiffView } from '@/components/chat/DiffView';
import { confirmWorkbenchMutation } from '@/api/workbench';
import { visibleProgress, type ProgressEntry } from '@/lib/tool-progress';
import { formatToolContext } from '@/lib/tool-context-format';
import { ProviderSetupWidget } from '@/components/chat/ProviderSetupWidget';
import { PermissionToast } from '@/components/overlays/PermissionToast';
import { extractDiffData, extractFilename } from './extractors';
import type { ToolEntry } from './types';
import {
  Section,
  FormattedSection,
  FormattedResultSection,
  FormattedErrorSection,
} from './sections';

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

  return (
    <div className="mt-0.5 w-full min-w-0 max-w-full overflow-hidden wrap-anywhere pb-1">
      {/* For read-type tools (context_read, memory_search, read_file etc.)
          the raw JSON input is noise — skip it so the user sees what was
          actually read (the result/summary) when they expand the card. */}
      {tool.context && !tool.name.match(/context_read|memory_search|read_file|search/) && (
        <FormattedSection toolName={tool.name} label="context" raw={tool.context} format={formatToolContext} />
      )}

      {(() => {
        const visible = progress ? visibleProgress(progress) : [];
        const total = progress?.length ?? 0;
        const overflow = Math.max(0, total - visible.length);
        if (visible.length === 0) return null;
        return (
          <div className="my-1.5 space-y-0.5" aria-label="Tool progress" data-tool-progress>
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
                  {entry.path}
                </span>
              </div>
            ))}
            {overflow > 0 && (
              <div className="text-[10px] text-muted-foreground/50 italic pl-4">
                + {overflow} more
              </div>
            )}
          </div>
        );
      })()}

      {tool.preview && tool.status === 'running' && (
        <Section label="streaming">
          {tool.preview}
          <span className="inline-block w-1.5 h-3 align-middle bg-foreground/40 ml-0.5 animate-pulse" />
        </Section>
      )}

      {(() => {
        const diffData = extractDiffData(tool);
        return diffData ? (
          <Section label="diff">
            <DiffView
              diff={diffData.diff}
              oldContent={diffData.oldContent}
              newContent={diffData.newContent}
            />
          </Section>
        ) : null;
      })()}

      {tool.searchHits && tool.searchHits.length > 0 && (
        <Section label="results">
          <ol className="m-0 grid list-none gap-3 p-0">
            {tool.searchHits.map((hit, i) => (
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
        </Section>
      )}

      {tool.summary && !tool.searchHits && !tool.providerSetup && (
        <FormattedResultSection toolName={tool.name} raw={tool.summary} />
      )}

      {tool.providerSetup && (
        <ProviderSetupWidget setup={tool.providerSetup} />
      )}

      {tool.error && (
        <FormattedErrorSection toolName={tool.name} raw={tool.error} />
      )}

      {tool.pendingApproval && approvalStatus !== 'confirmed' && (
        <div className="mt-2">
          {tool.pendingApproval.confirmationToken ? (
            /* Claude-style grant toast on the tool card (Once / This chat / Always). */
            <PermissionToast
              sessionId={(tool as { sessionId?: string }).sessionId || ''}
              token={tool.pendingApproval.confirmationToken}
              toolName={tool.name}
              path={extractFilename(tool.context) ?? undefined}
              summary={
                tool.pendingApproval.message ||
                tool.pendingApproval.detail ||
                `Allow ${tool.name}?`
              }
              onDecided={() => setApprovalStatus('confirmed')}
            />
          ) : (
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
          )}
        </div>
      )}
    </div>
  );
}
