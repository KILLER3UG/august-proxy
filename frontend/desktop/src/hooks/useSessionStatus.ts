/* ── Session status polling (React Query) ─────────────────────────────── */
/* Polls /api/workbench/session/:id/status for approval workflow */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export type SessionStatus = {
    sessionId: string;
    status: 'idle' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | string;
    pendingTool: string | null;
    pendingToken: string | null;
    pendingArgs: Record<string, unknown> | null;
    pendingPreview?: string | null;
    pendingCreatedAt: number | string | null;
    updatedAt: string | null;
    guardMode: 'plan' | 'ask' | 'full' | string;
    approved: boolean;
    pendingMutation?: {
        token?: string;
        toolName?: string;
        args?: Record<string, unknown>;
        preview?: string;
        createdAt?: string;
    } | null;
};

export function useSessionStatus(sessionId: string | null, pollIntervalMs: number = 12_000) {
    // Realtime bridge invalidates `session-status` on mutation; poll is a slow safety net.
    return useQuery<SessionStatus | null>({
        queryKey: ['session-status', sessionId],
        queryFn: async () => {
            if (!sessionId) return null;
            try {
                const raw = await api.get<SessionStatus & {
                    pendingMutation?: {
                        token?: string;
                        toolName?: string;
                        args?: Record<string, unknown>;
                        preview?: string;
                        createdAt?: string;
                    } | null;
                }>(
                    `/api/workbench/session/${encodeURIComponent(sessionId)}/status`
                );
                if (!raw) return null;
                // Normalize nested pendingMutation → flat fields the banner expects
                const pm = raw.pendingMutation;
                return {
                    ...raw,
                    pendingToken: raw.pendingToken ?? pm?.token ?? null,
                    pendingTool: raw.pendingTool ?? pm?.toolName ?? null,
                    pendingArgs: raw.pendingArgs ?? pm?.args ?? null,
                    pendingPreview: raw.pendingPreview ?? pm?.preview ?? null,
                    pendingCreatedAt: raw.pendingCreatedAt ?? pm?.createdAt ?? null,
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
