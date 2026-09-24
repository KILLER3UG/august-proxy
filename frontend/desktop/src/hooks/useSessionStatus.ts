/* ── Session status polling (React Query) ─────────────────────────────── */
/* Polls /api/workbench/session/:id/status for approval workflow */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export type PendingMutationItem = {
    token?: string;
    toolName?: string;
    args?: Record<string, unknown>;
    preview?: string;
    createdAt?: string;
    path?: string;
    grantKey?: string;
    /** Permission-axis classification, e.g. ['destructive'] or ['network']. */
    categories?: string[];
};

export type SessionStatus = {
    sessionId: string;
    status: 'idle' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
    pendingTool: string | null;
    pendingToken: string | null;
    pendingArgs: Record<string, unknown> | null;
    pendingPreview?: string | null;
    pendingPath?: string | null;
    pendingCreatedAt: number | string | null;
    updatedAt: string | null;
    /** Grant fingerprint of the last pending mutation (scope gating). */
    pendingGrantKey?: string | null;
    /** Permission-axis categories of the last pending mutation. */
    pendingCategories?: string[] | null;
    guardMode: 'plan' | 'ask' | 'edit' | 'full';
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
    sandboxNetwork?: boolean;
    approved: boolean;
    pendingMutation?: PendingMutationItem | null;
    /** Full batch for multi-file pre-apply cards */
    pendingMutations?: PendingMutationItem[];
};

export function useSessionStatus(sessionId: string | null, pollIntervalMs: number = 12_000) {
    // Realtime bridge invalidates `session-status` on mutation; poll is a slow safety net.
    return useQuery<SessionStatus | null>({
        queryKey: ['session-status', sessionId],
        queryFn: async () => {
            if (!sessionId) return null;
            try {
                const raw = await api.get<SessionStatus & {
                    pendingMutation?: PendingMutationItem | null;
                }>(
                    `/api/workbench/session/${encodeURIComponent(sessionId)}/status`
                );
                if (!raw) return null;
                // Normalize nested pendingMutation → flat fields the banner expects
                const pm = raw.pendingMutation;
                const batch = Array.isArray(raw.pendingMutations)
                    ? raw.pendingMutations
                    : pm
                      ? [pm]
                      : [];
                return {
                    ...raw,
                    pendingToken: raw.pendingToken ?? pm?.token ?? null,
                    pendingTool: raw.pendingTool ?? pm?.toolName ?? null,
                    pendingArgs: raw.pendingArgs ?? pm?.args ?? null,
                    pendingPreview: raw.pendingPreview ?? pm?.preview ?? null,
                    pendingPath: raw.pendingPath ?? pm?.path ?? null,
                    pendingCreatedAt: raw.pendingCreatedAt ?? pm?.createdAt ?? null,
                    pendingMutations: batch,
                    // Scope inputs for the approval card, hoisted so the
                    // single-pending fallback in MutationDiffCards can gate
                    // the durable choice without re-reading the nested blob.
                    pendingGrantKey: pm?.grantKey ?? null,
                    pendingCategories: pm?.categories ?? null,
                };
            } catch (error) {
                // 404 means session is gone
                if (error instanceof Error && 'status' in error && (error as {status: number}).status === 404) {
                    return null;
                }
                return null;
            }
        },
        enabled: !!sessionId,
        refetchInterval: pollIntervalMs,
        staleTime: 500,
    });
}
