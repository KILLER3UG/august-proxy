/* ── MutationDiffCards ────────────────────────────────────────────────── */
/* Multi-file pre-apply UI: one card per pending mutation with DiffView,  */
/* Accept/Reject (and Once / This chat / Always) per path.                */

import { useMemo, useState } from 'react';
import { FileCode2, ShieldAlert } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { DiffView } from '@/components/chat/DiffView';
import { PermissionToast, type GrantScope } from '@/components/overlays/PermissionToast';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { PendingMutationItem, SessionStatus } from '@/hooks/useSessionStatus';

type Props = {
  sessionId: string;
  status: SessionStatus | null | undefined;
  className?: string;
  /** Reattach chat SSE after backend continues the turn. */
  onContinued?: (sinceSeq: number) => void;
};

type DecisionResult = {
  status?: string;
  executed?: boolean;
  continued?: boolean;
  sinceSeq?: number;
};

function pathFromMutation(m: PendingMutationItem): string {
  if (typeof m.path === 'string' && m.path) return m.path;
  const args = m.args || {};
  for (const key of ['path', 'file_path', 'filePath', 'file', 'target', 'target_file']) {
    const v = args[key];
    if (typeof v === 'string' && v) return v;
  }
  return m.toolName || 'change';
}

function diffPropsFromMutation(m: PendingMutationItem): {
  diff?: string;
  oldContent?: string;
  newContent?: string;
} | null {
  const args = m.args || {};
  const oldString =
    (typeof args.old_string === 'string' && args.old_string) ||
    (typeof args.oldString === 'string' && args.oldString) ||
    (typeof args.find === 'string' && args.find) ||
    (typeof args.old === 'string' && args.old) ||
    undefined;
  const newString =
    (typeof args.new_string === 'string' && args.new_string) ||
    (typeof args.newString === 'string' && args.newString) ||
    (typeof args.replace === 'string' && args.replace) ||
    (typeof args.content === 'string' && args.content) ||
    (typeof args.new === 'string' && args.new) ||
    (typeof args.text === 'string' && args.text) ||
    undefined;

  if (typeof args.diff === 'string' && args.diff) return { diff: args.diff };
  if (typeof args.patch === 'string' && args.patch) return { diff: args.patch };
  if (oldString !== undefined && newString !== undefined) {
    return { oldContent: oldString, newContent: newString };
  }
  if (newString !== undefined) {
    return { oldContent: '', newContent: newString };
  }
  // Fall back to preview text as a simple all-added block when possible
  if (m.preview && m.preview.length > 0 && !m.preview.startsWith('Run:')) {
    const body = m.preview.includes('\n\n')
      ? m.preview.split('\n\n').slice(1).join('\n\n')
      : m.preview;
    if (body && body.length < 8000) {
      return { oldContent: '', newContent: body };
    }
  }
  return null;
}

async function postDecision(
  sessionId: string,
  token: string,
  reject: boolean,
  scope: GrantScope = 'once',
) {
  return api.post<DecisionResult>(
    '/api/workbench/confirm-mutation',
    { sessionId, token, reject, scope, continue: true },
  );
}

function MutationCard({
  sessionId,
  mutation,
  onContinued,
}: {
  sessionId: string;
  mutation: PendingMutationItem;
  onContinued?: (sinceSeq: number) => void;
}) {
  const [deciding, setDeciding] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  const qc = useQueryClient();
  const path = pathFromMutation(mutation);
  const diff = useMemo(() => diffPropsFromMutation(mutation), [mutation]);
  const token = mutation.token || '';

  const decide = async (reject: boolean, scope: GrantScope = 'once') => {
    if (!token) return;
    setDeciding(reject ? 'reject' : scope);
    try {
      const res = await postDecision(sessionId, token, reject, scope);
      void qc.invalidateQueries({ queryKey: ['session-status', sessionId] });
      if (reject) {
        toast.message(`Rejected ${path}`);
      } else {
        toast.success(
          res?.executed ? `Applied ${path}` : `Accepted ${path}`,
        );
      }
      // Backend already kicked off the continuation — attach the live stream.
      if (res?.continued && Number.isFinite(res.sinceSeq)) {
        onContinued?.(res.sinceSeq as number);
      }
    } catch (e) {
      toast.error(`Decision failed: ${(e as Error).message}`);
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div
      className="rounded-lg border border-warning/30 bg-warning/5 overflow-hidden"
      data-testid="mutation-diff-card"
    >
      <div className="flex items-start gap-2 px-3 py-2 border-b border-warning/20">
        <FileCode2 className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate" title={path}>
            {path.startsWith('sandbox:unsandboxed:')
              ? 'Unsandboxed command'
              : path}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {path.startsWith('sandbox:unsandboxed:')
              ? 'Sandbox escape · Once / This chat / Always'
              : `${mutation.toolName || 'tool'} · pre-apply review`}
          </div>
        </div>
      </div>

      {diff ? (
        <div className="max-h-56 overflow-auto border-b border-warning/15">
          <DiffView {...diff} maxLines={80} />
        </div>
      ) : mutation.preview ? (
        <pre className="max-h-40 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap border-b border-warning/15">
          {mutation.preview}
        </pre>
      ) : null}

      {showToast ? (
        <div className="p-2">
          <PermissionToast
            sessionId={sessionId}
            token={token}
            toolName={mutation.toolName}
            path={path}
            summary={`${mutation.toolName || 'tool'} → ${path}`}
            onDecided={() => setShowToast(false)}
            onContinued={onContinued}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-1.5 px-3 py-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px] border-warning/40 text-warning"
            disabled={!!deciding || !token}
            onClick={() => {
              void decide(true);
            }}
          >
            {deciding === 'reject' ? '…' : 'Reject'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            disabled={!!deciding || !token}
            onClick={() => {
              void decide(false, 'once');
            }}
          >
            {deciding === 'once' ? 'Applying…' : 'Accept'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px]"
            disabled={!!deciding || !token}
            onClick={() => setShowToast(true)}
            title="Choose Once / This chat / Always"
          >
            More…
          </Button>
        </div>
      )}
    </div>
  );
}

export function MutationDiffCards({
  sessionId,
  status,
  className,
  onContinued,
}: Props) {
  const items = useMemo(() => {
    if (!status) return [];
    if (Array.isArray(status.pendingMutations) && status.pendingMutations.length > 0) {
      return status.pendingMutations.filter((m) => m?.token);
    }
    if (status.pendingToken) {
      return [
        {
          token: status.pendingToken,
          toolName: status.pendingTool ?? undefined,
          args: status.pendingArgs ?? undefined,
          preview: status.pendingPreview ?? undefined,
          path: status.pendingPath ?? undefined,
        } satisfies PendingMutationItem,
      ];
    }
    return [];
  }, [status]);

  // Show whenever there are pending tokens — do not require status ===
  // awaiting_approval, or a brief idle flicker after approving one of many
  // will hide the rest of the stack.
  if (items.length === 0) return null;

  // Single non-file mutation: keep one card; multi-file batches get a header.
  // Width/centering is owned by the chat footer (composer slot).
  return (
    <div
      className={cn('flex w-full flex-col gap-2', className)}
      data-testid="mutation-diff-cards"
    >
      {items.length > 1 && (
        <div className="flex items-center gap-2 px-1 text-xs text-warning">
          <ShieldAlert className="size-3.5" />
          <span className="font-medium">
            {items.length} changes need approval — accept or reject each path
          </span>
        </div>
      )}
      {items.map((m) => (
        <MutationCard
          key={m.token}
          sessionId={sessionId}
          mutation={m}
          onContinued={onContinued}
        />
      ))}
    </div>
  );
}

export default MutationDiffCards;
