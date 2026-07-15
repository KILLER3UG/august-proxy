/* ── ApprovalBanner ───────────────────────────────────────────────────── */
/* Session-level pre-apply "Accept / Reject" banner driven by session status. */
/* Polls the endpoint; shows when the server has a pending critical mutation. */
/* Accept once / This chat / Always for folder / Reject → POST confirm-mutation. */
/* On Accept the backend executes the tool with stored args (pre-apply). */

import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, X, Shield } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import type { SessionStatus } from '@/hooks/useSessionStatus';
import { api } from '@/api/client';

export type { SessionStatus } from '@/hooks/useSessionStatus';

type GrantScope = 'once' | 'session' | 'always';

type Props = {
  sessionId: string | null;
  pollIntervalMs?: number;
  onStatusChange?: (status: SessionStatus | null) => void;
};

async function postDecision(
  sessionId: string,
  token: string,
  reject: boolean,
  scope: GrantScope = 'once',
) {
  return api.post<{
    status?: string;
    continued?: boolean;
    executed?: boolean;
    toolResult?: string;
    message?: string;
  }>('/api/workbench/confirm-mutation', {
    sessionId,
    token,
    reject,
    scope,
    continue: true,
  });
}

function summarizeTool(toolName: string | null, args: Record<string, unknown> | null): string {
  if (!toolName) return 'The model is waiting for your approval.';
  if (!args) return `Tool: ${toolName}`;
  const path =
    (typeof args.path === 'string' && args.path) ||
    (typeof args.file_path === 'string' && args.file_path) ||
    (typeof args.filePath === 'string' && args.filePath) ||
    (typeof args.file === 'string' && args.file) ||
    '';
  const cmd =
    (typeof args.command === 'string' && args.command) ||
    (typeof args.cmd === 'string' && args.cmd) ||
    '';
  if (path) return `${toolName} → ${path}`;
  if (cmd) return `${toolName}: ${cmd.slice(0, 100)}`;
  const keys = Object.keys(args).filter((k) => k !== 'confirmed' && k !== 'reReadFirst');
  const first = keys[0];
  if (first) {
    const value = typeof args[first] === 'string' ? args[first] : JSON.stringify(args[first] ?? '');
    return `Tool: ${toolName} — ${first}: ${String(value).slice(0, 80)}`;
  }
  return `Tool: ${toolName}`;
}

export function ApprovalBanner({ sessionId, pollIntervalMs = 2000, onStatusChange }: Props) {
  const { data: status } = useSessionStatus(sessionId, pollIntervalMs);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [showFullArgs, setShowFullArgs] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    onStatusChange?.(status ?? null);
  }, [status, onStatusChange]);

  useEffect(() => {
    setShowFullArgs(false);
  }, [status?.pendingToken]);

  const isAwaiting = status?.status === 'awaiting_approval' && !!status.pendingToken;
  const summary = useMemo(
    () => summarizeTool(status?.pendingTool ?? null, status?.pendingArgs ?? null),
    [status?.pendingTool, status?.pendingArgs],
  );

  const preview =
    status?.pendingPreview ||
    (status as SessionStatus & { pendingPreview?: string | null })?.pendingPreview ||
    (typeof status?.pendingArgs?.content === 'string'
      ? String(status.pendingArgs.content).slice(0, 1200)
      : typeof status?.pendingArgs?.new_string === 'string'
        ? String(status.pendingArgs.new_string).slice(0, 1200)
        : typeof status?.pendingArgs?.command === 'string'
          ? `Run: ${String(status.pendingArgs.command).slice(0, 500)}`
          : null);

  const decide = async (reject: boolean, scope: GrantScope = 'once') => {
    if (!status?.pendingToken) return;
    setDeciding(reject ? 'reject' : scope);
    try {
      const res = await postDecision(status.sessionId, status.pendingToken, reject, scope);
      void qc.invalidateQueries({ queryKey: ['session-status', sessionId] });
      if (reject) {
        toast.message('Rejected — change was not applied');
      } else {
        const scopeLabel =
          scope === 'always'
            ? 'Always for this folder'
            : scope === 'session'
              ? 'This chat'
              : 'Once';
        if (res?.executed) {
          toast.success(
            res?.continued
              ? `Accepted (${scopeLabel}) — change applied, August is continuing`
              : `Accepted (${scopeLabel}) — change applied`,
          );
        } else {
          toast.success(
            res?.continued
              ? `Accepted (${scopeLabel}) — August is continuing`
              : `Accepted (${scopeLabel})`,
          );
        }
      }
    } catch (e) {
      toast.error(`${reject ? 'Reject' : 'Accept'} failed: ${(e as Error).message}`);
    } finally {
      setDeciding(null);
    }
  };

  return (
    <AnimatePresence>
      {isAwaiting && (
        <motion.div
          key="approval-banner"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
          className={cn(
            'mx-auto my-2 flex w-full max-w-3xl flex-col gap-3 rounded-lg border px-4 py-3',
            'border-warning/30 bg-warning/10 text-foreground',
          )}
          data-testid="approval-banner"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 flex-none text-warning" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">Review change before it applies</div>
              <div className="text-warning/90 break-all">{summary}</div>
              {preview && (
                <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-warning/20 bg-black/25 p-2 font-mono text-[11px] leading-relaxed text-foreground/85 whitespace-pre-wrap">
                  {preview}
                </pre>
              )}
              {status?.pendingArgs && (
                <details
                  className="mt-1 text-xs text-warning/80"
                  open={showFullArgs}
                  onToggle={(e) => setShowFullArgs((e.target as HTMLDetailsElement).open)}
                >
                  <summary className="cursor-pointer">
                    {preview ? 'View full arguments' : 'View proposed arguments'}
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-black/30 p-2 text-[11px]">
                    {JSON.stringify(status.pendingArgs, null, 2)}
                  </pre>
                </details>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                <span className="text-foreground/80">Accept</span> runs this change now with the
                arguments above. <span className="text-foreground/80">Reject</span> discards it.
                Choose how long similar permissions last.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 pl-8">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void decide(true);
              }}
              disabled={!!deciding}
              className="border-warning/40 text-warning hover:bg-warning/20"
            >
              <X className="mr-1 h-3.5 w-3.5" />
              {deciding === 'reject' ? 'Rejecting…' : 'Reject'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void decide(false, 'once');
              }}
              disabled={!!deciding}
            >
              <ShieldCheck className="mr-1 h-3.5 w-3.5" />
              {deciding === 'once' ? 'Applying…' : 'Accept once'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void decide(false, 'session');
              }}
              disabled={!!deciding}
            >
              <Shield className="mr-1 h-3.5 w-3.5" />
              {deciding === 'session' ? '…' : 'Accept this chat'}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void decide(false, 'always');
              }}
              disabled={!!deciding}
              className="bg-warning text-black hover:bg-warning/90"
              title="Remember for this workspace folder and apply now"
            >
              <ShieldCheck className="mr-1 h-3.5 w-3.5" />
              {deciding === 'always' ? '…' : 'Accept always here'}
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default ApprovalBanner;
