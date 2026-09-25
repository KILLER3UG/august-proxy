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
    // One bounded retry: a single early/transient failure previously nulled
    // the state and left the ring on the bare local fallback (tool
    // definitions only) until the next turn flipped the refresh key.
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchOnce = () => {
      attempt += 1;
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
          if (cancelled) return;
          if (attempt === 1) {
            retryTimer = setTimeout(fetchOnce, 1200);
            return;
          }
          setSessionUsage(null);
        });
    };
    fetchOnce();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [sessionId, workbenchSessionId, fallbackWorkbenchId, refreshKey]);

  return sessionUsage;
}
