/* ── Session status polling (React Query) ─────────────────────────────── */
/* Polls /api/workbench/session/:id/status for approval workflow */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export type SessionStatus = {
    sessionId: string;
    status: 'idle' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
    pendingTool: string | null;
    pendingToken: string | null;
    pendingArgs: Record<string, unknown> | null;
    pendingCreatedAt: number | null;
    updatedAt: string | null;
    guardMode: 'plan' | 'ask' | 'full';
    approved: boolean;
};

export function useSessionStatus(sessionId: string | null, pollIntervalMs: number = 2000) {
    return useQuery<SessionStatus | null>({
        queryKey: ['session-status', sessionId],
        queryFn: async () => {
            if (!sessionId) return null;
            try {
                return await api.get<SessionStatus>(
                    `/api/workbench/session/${encodeURIComponent(sessionId)}/status`
                );
            } catch (error) {
                // 404 means session is gone
                if (error instanceof Error && 'status' in error && (error as any).status === 404) {
                    return null;
                }
                return null;
            }
        },
        enabled: !!sessionId,
        refetchInterval: pollIntervalMs,
        staleTime: 1000,
    });
}
