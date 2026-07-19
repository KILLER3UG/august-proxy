/* ── PermissionToast ──────────────────────────────────────────────────── */
/* Lightweight grant toast: Once / This chat / Always here.  */
/* Reuses POST /api/workbench/confirm-mutation (same grant store as banner). */

import { useState } from 'react';
import { Shield, ShieldCheck, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { PERMISSION_COPY } from '@/lib/permission-copy';

export type GrantScope = 'once' | 'session' | 'always';

type Props = {
  sessionId: string;
  token: string;
  toolName?: string | null;
  path?: string | null;
  summary?: string | null;
  compact?: boolean;
  className?: string;
  onDecided?: (reject: boolean, scope: GrantScope) => void;
  /** Reattach chat SSE after backend continues the turn. */
  onContinued?: (sinceSeq: number) => void;
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
    sinceSeq?: number;
    executed?: boolean;
    message?: string;
  }>('/api/workbench/confirm-mutation', {
    sessionId,
    token,
    reject,
    scope,
    continue: true,
  });
}

export function PermissionToast({
  sessionId,
  token,
  toolName,
  path,
  summary,
  compact = true,
  className,
  onDecided,
  onContinued,
}: Props) {
  const [deciding, setDeciding] = useState<string | null>(null);
  const qc = useQueryClient();

  const label =
    summary ||
    (toolName && path ? `${toolName} → ${path}` : toolName || 'Permission needed');

  const decide = async (reject: boolean, scope: GrantScope = 'once') => {
    setDeciding(reject ? 'reject' : scope);
    try {
      const res = await postDecision(sessionId, token, reject, scope);
      void qc.invalidateQueries({ queryKey: ['session-status', sessionId] });
      onDecided?.(reject, scope);
      if (reject) {
        toast.message('Rejected — change was not applied');
      } else {
        const scopeLabel =
          scope === 'always' ? 'Always here' : scope === 'session' ? 'This chat' : 'Once';
        toast.success(
          res?.executed
            ? `Accepted (${scopeLabel}) — applied`
            : `Accepted (${scopeLabel})`,
        );
      }
      if (res?.continued && Number.isFinite(res.sinceSeq)) {
        onContinued?.(res.sinceSeq as number);
      }
    } catch (e) {
      toast.error(`${reject ? 'Reject' : 'Accept'} failed: ${(e as Error).message}`);
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs shadow-sm',
        className,
      )}
      data-testid="permission-toast"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2 min-w-0">
        <Shield className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground/90">
            {compact ? PERMISSION_COPY.title : PERMISSION_COPY.preApply}
          </div>
          <div className="truncate text-warning/90" title={label}>
            {label}
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">{PERMISSION_COPY.subtitle}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px] text-warning hover:bg-warning/15"
          disabled={!!deciding}
          onClick={() => {
            void decide(true);
          }}
          title={PERMISSION_COPY.rejectHint}
        >
          <X className="mr-0.5 size-3" />
          {deciding === 'reject' ? '…' : PERMISSION_COPY.reject}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          disabled={!!deciding}
          onClick={() => {
            void decide(false, 'once');
          }}
          title={PERMISSION_COPY.onceHint}
        >
          <ShieldCheck className="mr-0.5 size-3" />
          {deciding === 'once' ? '…' : PERMISSION_COPY.once}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          disabled={!!deciding}
          onClick={() => {
            void decide(false, 'session');
          }}
          title={PERMISSION_COPY.sessionHint}
        >
          {deciding === 'session' ? '…' : PERMISSION_COPY.session}
        </Button>
        <Button
          size="sm"
          className="h-7 px-2 text-[11px] bg-warning text-black hover:bg-warning/90"
          disabled={!!deciding}
          onClick={() => {
            void decide(false, 'always');
          }}
          title={PERMISSION_COPY.alwaysHint}
        >
          {deciding === 'always' ? '…' : PERMISSION_COPY.always}
        </Button>
      </div>
    </div>
  );
}

export default PermissionToast;
