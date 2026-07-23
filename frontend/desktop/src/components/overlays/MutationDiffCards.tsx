/* ── MutationDiffCards ────────────────────────────────────────────────── */
/* Pending mutations → Cursor-style PermissionRequiredCard (Allow/Always/Deny). */

import { useMemo, useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { DiffView } from '@/components/chat/DiffView';
import {
  PermissionRequiredCard,
  type PermissionChoice,
} from '@/components/overlays/PermissionRequiredCard';
import type { GrantScope } from '@/components/overlays/PermissionToast';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { getToolLabel, pathBasename } from '@/lib/tool-labels';
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

function commandFromMutation(m: PendingMutationItem): string | null {
  const args = m.args || {};
  for (const key of ['command', 'cmd', 'shell', 'script']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const preview = m.preview || '';
  if (preview.startsWith('Run:')) {
    return preview.slice(4).trim() || null;
  }
  const path = pathFromMutation(m);
  if (path.startsWith('sandbox:unsandboxed:')) {
    return path.slice('sandbox:unsandboxed:'.length).trim() || null;
  }
  return null;
}

function descriptionFromMutation(m: PendingMutationItem): string {
  const args = m.args || {};
  for (const key of ['description', 'summary', 'reason', 'goal', 'title']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // Same phrasing convention as the chat TaskTrigger titles: tool name +
  // primary target (basename / command), never the raw function name.
  const cmd = commandFromMutation(m);
  if (cmd) {
    return getToolLabel('run_command', { command: cmd, status: 'running' });
  }
  const path = pathFromMutation(m);
  if (path.startsWith('sandbox:unsandboxed:')) {
    return 'Unsandboxed command';
  }
  const tool = m.toolName || 'tool';
  const label = getToolLabel(tool, {
    filename: path && path !== tool ? path : undefined,
    status: 'running',
  });
  if (label && !/executing tool/i.test(label)) return label;
  const preview = (m.preview || '').trim();
  if (preview) {
    const first = preview.split('\n').find((l) => l.trim()) || preview;
    return first.length > 100 ? `${first.slice(0, 97)}…` : first;
  }
  return tool;
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

function previewFromMutation(m: PendingMutationItem): ReactNode {
  const cmd = commandFromMutation(m);
  if (cmd) {
    // Terminal-style block: `$ command` on its own line, output below it.
    return (
      <div className="px-3 py-2.5 font-mono text-[12px] leading-relaxed">
        <div className="whitespace-pre-wrap break-all">
          <span className="select-none text-muted-foreground">$ </span>
          {cmd}
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">No output.</div>
      </div>
    );
  }

  const diff = diffPropsFromMutation(m);
  if (
    diff &&
    ((diff.diff ?? '').length > 0 ||
      (diff.newContent ?? '').length > 0 ||
      (diff.oldContent ?? '').length > 0)
  ) {
    return <DiffView {...diff} maxLines={80} />;
  }

  if (m.preview) {
    return (
      <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed">
        {m.preview}
      </pre>
    );
  }

  return (
    <div className="px-3 py-2.5 text-[12px] text-muted-foreground">
      No preview available.
    </div>
  );
}

function choiceToDecision(choice: PermissionChoice): {
  reject: boolean;
  scope: GrantScope;
} {
  if (choice === 'deny' || choice === 'instructions') {
    return { reject: true, scope: 'once' };
  }
  if (choice === 'always') return { reject: false, scope: 'always' };
  return { reject: false, scope: 'once' };
}

async function postDecision(
  sessionId: string,
  token: string,
  reject: boolean,
  scope: GrantScope = 'once',
  instructions?: string,
) {
  return api.post<DecisionResult>(
    '/api/workbench/confirm-mutation',
    { sessionId, token, reject, scope, continue: true, instructions },
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
  const [confirming, setConfirming] = useState(false);
  const qc = useQueryClient();
  const path = pathFromMutation(mutation);
  const token = mutation.token || '';
  const description = useMemo(
    () => descriptionFromMutation(mutation),
    [mutation],
  );
  const preview = useMemo(() => previewFromMutation(mutation), [mutation]);

  const handleConfirm = async (choice: PermissionChoice, instructions?: string) => {
    if (!token || confirming) return;
    const { reject, scope } = choiceToDecision(choice);
    setConfirming(true);
    try {
      const res = await postDecision(sessionId, token, reject, scope, instructions);
      void qc.invalidateQueries({ queryKey: ['session-status', sessionId] });
      const shortPath = pathBasename(path);
      if (choice === 'instructions') {
        toast.success('Instructions sent');
      } else if (reject) {
        toast.message(`Denied ${shortPath}`);
      } else {
        toast.success(res?.executed ? `Applied ${shortPath}` : `Allowed ${shortPath}`);
      }
      if (res?.continued && Number.isFinite(res.sinceSeq)) {
        onContinued?.(res.sinceSeq as number);
      }
    } catch (e) {
      toast.error(`Decision failed: ${(e as Error).message}`);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <PermissionRequiredCard
      description={description}
      preview={preview}
      disabled={!token}
      confirming={confirming}
      onConfirm={handleConfirm}
    />
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

  return (
    <div
      className={cn('flex w-full flex-col gap-2', className)}
      data-testid="mutation-diff-cards"
    >
      {items.length > 1 && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <ShieldAlert className="size-3.5 text-warning" />
          <span className="font-medium">
            {items.length} changes need approval — confirm each one
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

/** Exported for unit tests. */
export { choiceToDecision, commandFromMutation, descriptionFromMutation };
