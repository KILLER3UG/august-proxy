/* ── useChatUsage ─────────────────────────────────────────────────────── */
/* Per-session token + cost usage for the context ring.                   */

import { useEffect, useState } from 'react';
import { usageApi } from '@/api/usage';

export type SessionUsageState = {
  total: number;
  input: number;
  output: number;
  contextTokens: number;
  totalCost?: number;
  /** The cost came from a family-table guess, not a price set on the model. */
  costEstimated?: boolean;
  /** Universal prompt-cache split for the context ring. */
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cacheHitRate?: number;
} | null;

export function useChatUsage(
  sessionId: string | null,
  workbenchSessionId?: string | null,
  fallbackWorkbenchId?: string | null,
  /** Bump when a turn finishes so the ring refreshes from server usage. */
  refreshKey?: number | string | boolean,
) {
  const [sessionUsage, setSessionUsage] = useState<SessionUsageState>(null);

  useEffect(() => {
    const sotId =
      workbenchSessionId ||
      fallbackWorkbenchId ||
      (sessionId?.startsWith('wb_') ? sessionId : '') ||
      sessionId;
    if (!sotId) {
      setSessionUsage(null);
      return;
    }

    let cancelled = false;
    usageApi
      .session(sotId)
      .then((data) => {
        if (cancelled) return;
        setSessionUsage({
          total: data.totalTokens,
          input: data.totalInputTokens,
          output: data.totalOutputTokens,
          contextTokens: data.contextTokens ?? 0,
          totalCost: data.totalCost ?? 0,
          costEstimated: data.costEstimated ?? true,
          cacheHitTokens: data.cacheHitTokens ?? 0,
          cacheMissTokens: data.cacheMissTokens ?? 0,
          cacheHitRate: data.cacheHitRate ?? 0,
        });
      })
      .catch(() => {
        if (!cancelled) setSessionUsage(null);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, workbenchSessionId, fallbackWorkbenchId, refreshKey]);

  return sessionUsage;
}
