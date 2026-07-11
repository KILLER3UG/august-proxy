/* ── ApprovalBanner ───────────────────────────────────────────────────── */
/* Session-level "awaiting approval" banner driven by /api/workbench/session/:id/status. */
/* Polls the endpoint every 2s; flips to a sticky banner when the server */
/* reports a pending critical mutation. Approve / Deny buttons POST to */
/* /api/workbench/confirm-mutation. */

import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import type { SessionStatus } from '@/hooks/useSessionStatus';
import { api } from '@/api/client';

export type { SessionStatus } from '@/hooks/useSessionStatus';

type Props = {
    sessionId: string | null;
    pollIntervalMs?: number;
    onStatusChange?: (status: SessionStatus | null) => void;
};

async function postDecision(sessionId: string, token: string, reject: boolean) {
    return api.post<{ success: boolean }>('/api/workbench/confirm-mutation', {
        sessionId,
        token,
        reject,
    });
}

function summarizeTool(toolName: string | null, args: Record<string, unknown> | null): string {
    if (!toolName) return 'The model is waiting for your approval.';
    if (!args) return `Tool: ${toolName}`;
    const keys = Object.keys(args).filter((k) => k !== 'confirmed' && k !== 'reReadFirst');
    const first = keys[0];
    if (first) {
        const value = typeof args[first] === 'string' ? args[first] : JSON.stringify(args[first] ?? '');
        return `Tool: ${toolName} — ${first}: ${value.slice(0, 80)}`;
    }
    return `Tool: ${toolName}`;
}

export function ApprovalBanner({ sessionId, pollIntervalMs = 2000, onStatusChange }: Props) {
    const { data: status } = useSessionStatus(sessionId, pollIntervalMs);
    const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);

    useEffect(() => {
        onStatusChange?.(status ?? null);
    }, [status, onStatusChange]);

    const isAwaiting = status?.status === 'awaiting_approval' && !!status.pendingToken;
    const summary = useMemo(
        () => summarizeTool(status?.pendingTool ?? null, status?.pendingArgs ?? null),
        [status?.pendingTool, status?.pendingArgs]
    );

    const onApprove = async () => {
        if (!status?.pendingToken) return;
        setDeciding('approve');
        try {
            await postDecision(status.sessionId, status.pendingToken, false);
            toast.success('Approved — resuming the model');
        } catch (e) {
            toast.error(`Approval failed: ${(e as Error).message}`);
        } finally {
            setDeciding(null);
        }
    };

    const onReject = async () => {
        if (!status?.pendingToken) return;
        setDeciding('reject');
        try {
            await postDecision(status.sessionId, status.pendingToken, true);
            toast.message('Denied — the model will be told');
        } catch (e) {
            toast.error(`Denial failed: ${(e as Error).message}`);
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
                        'mx-auto my-2 flex w-full max-w-3xl items-start gap-3 rounded-lg border px-4 py-3',
                        'border-warning/30 bg-warning/10 text-foreground'
                    )}
                    data-testid="approval-banner"
                    role="status"
                    aria-live="polite"
                >
                    <ShieldAlert className="mt-0.5 h-5 w-5 flex-none text-warning" />
                    <div className="flex-1 text-sm">
                        <div className="font-medium">Awaiting your approval</div>
                        <div className="text-warning/90">{summary}</div>
                        {status?.pendingArgs && (
                            <details className="mt-1 text-xs text-warning/80">
                                <summary className="cursor-pointer">View arguments</summary>
                                <pre className="mt-1 max-h-32 overflow-auto rounded bg-black/30 p-2 text-[11px]">
                                    {JSON.stringify(status.pendingArgs, null, 2)}
                                </pre>
                            </details>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => { void onReject(); }}
                            disabled={!!deciding}
                            className="border-warning/40 text-warning hover:bg-warning/20"
                        >
                            <X className="mr-1 h-3.5 w-3.5" />
                            Deny
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => { void onApprove(); }}
                            disabled={!!deciding}
                            className="bg-warning text-black hover:bg-warning/90"
                        >
                            <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                            {deciding === 'approve' ? 'Approving…' : 'Approve'}
                        </Button>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

export default ApprovalBanner;